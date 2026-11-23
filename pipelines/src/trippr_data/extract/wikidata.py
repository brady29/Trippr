"""Wikidata via the public SPARQL endpoint (the Wikidata Query Service), cached on disk.

Per city:
1. One `wikibase:around` query for items with coordinates inside the city's circle whose direct
   instance-of (P31) is one of the classes in config/category_map_wikidata.csv and that have at least
   one sitelink (notable enough to have a Wikipedia article in some language). Direct classes only: a
   subclass path (P31/P279*) took 55 s for Kyoto against 3 s for the direct form.
2. Batched `VALUES` queries (150 QIDs) for labels, description, website, English Wikipedia link,
   coordinates and sitelink count, for those items and for the QIDs that OpenStreetMap and Wikivoyage
   name in the same city when their raw files for the run date exist ("linked" items, which are kept
   even when their class is not in the CSV, so sitelink counts can be attached to matched places).

Usage policy checked 2026-11-22 (https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual and
https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy): a descriptive
User-Agent with a contact URL, 60 s per query, at most 5 parallel queries (we run one at a time), and
back off on 429 using Retry-After.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any

import duckdb

from ..cities import City, load_countries
from ..duck import connect, rows, sql_str
from ..layout import raw_dir, raw_sources
from ..registry import Registry
from ..settings import CONFIG_DIR
from ..taxonomy import EXCLUDE, load_category_map, load_taxonomy
from .common import ExtractRun
from .http import USER_AGENT, PoliteClient

log = logging.getLogger(__name__)

SOURCE = "wikidata"
ENDPOINT = "https://query.wikidata.org/sparql"
MIN_INTERVAL_S = 6.0
BATCH_SIZE = 150
MIN_SITELINKS = 1
QID_RE = re.compile(r"^Q[1-9]\d*$")
POINT_RE = re.compile(r"Point\(\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s*\)")

RADIUS_QUERY = """SELECT ?item ?cls ?clsLabel ?loc ?links WHERE {{
  SERVICE wikibase:around {{
    ?item wdt:P625 ?loc .
    bd:serviceParam wikibase:center "Point({lon} {lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "{radius_km}" .
  }}
  ?item wdt:P31 ?cls .
  VALUES ?cls {{ {classes} }}
  ?item wikibase:sitelinks ?links .
  FILTER(?links >= {min_links})
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}"""

DETAIL_QUERY = """SELECT ?item (SAMPLE(?loc) AS ?coord) (MAX(?links) AS ?sitelinks)
       (SAMPLE(?lbl_en) AS ?label_en) (SAMPLE(?lbl_loc) AS ?label_local)
       (SAMPLE(?desc) AS ?description) (SAMPLE(?web) AS ?website) (SAMPLE(?art) AS ?wikipedia)
       (GROUP_CONCAT(DISTINCT STRAFTER(STR(?cls), "entity/"); separator=" ") AS ?classes)
WHERE {{
  VALUES ?item {{ {items} }}
  OPTIONAL {{ ?item wdt:P625 ?loc }}
  OPTIONAL {{ ?item wikibase:sitelinks ?links }}
  OPTIONAL {{ ?item wdt:P31 ?cls }}
  OPTIONAL {{ ?item rdfs:label ?lbl_en . FILTER(lang(?lbl_en) = "en") }}
  OPTIONAL {{ ?item rdfs:label ?lbl_loc . FILTER(lang(?lbl_loc) IN ({languages})) }}
  OPTIONAL {{ ?item schema:description ?desc . FILTER(lang(?desc) = "en") }}
  OPTIONAL {{ ?item wdt:P856 ?web }}
  OPTIONAL {{ ?art schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }}
}} GROUP BY ?item"""


def class_qids(config_dir: Path = CONFIG_DIR) -> list[str]:
    rules = load_category_map(SOURCE, load_taxonomy(config_dir), config_dir).rules
    return [qid for qid, target in rules.items() if target != EXCLUDE]


def radius_query(city: City, classes: list[str], min_links: int = MIN_SITELINKS) -> str:
    return RADIUS_QUERY.format(
        lon=city.lon,
        lat=city.lat,
        radius_km=city.radius_km,
        classes=" ".join(f"wd:{q}" for q in classes),
        min_links=min_links,
    )


def detail_query(qids: list[str], languages: list[str]) -> str:
    return DETAIL_QUERY.format(
        items=" ".join(f"wd:{q}" for q in qids),
        languages=", ".join(json.dumps(lang.lower()) for lang in (languages or ["zz"])),
    )


def parse_point(value: str | None) -> tuple[float, float] | None:
    """(lat, lon) from a WKT literal 'Point(lon lat)'."""
    match = POINT_RE.search(value or "")
    return (float(match.group(2)), float(match.group(1))) if match else None


def qid_of(uri: str) -> str:
    return uri.rsplit("/", 1)[-1]


def sparql(client: PoliteClient, query: str) -> list[dict[str, dict[str, str]]]:
    raw = client.request(
        ENDPOINT, data={"query": query}, headers={"Accept": "application/sparql-results+json"}
    )
    return json.loads(raw)["results"]["bindings"]


def _cached_json(path: Path, build) -> Any:
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    result = build()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8", newline="\n")
    tmp.replace(path)
    return result


def linked_qids(out: Path, date: str, city: City) -> set[str]:
    """QIDs named by this city's OpenStreetMap features and Wikivoyage listings (when extracted)."""
    found: set[str] = set()
    available = raw_sources(out, date)
    con = connect()
    try:
        osm_file = raw_dir(out, "osm", date) / f"{city.code}.parquet"
        if "osm" in available and osm_file.is_file():
            for (value,) in con.execute(
                f"SELECT DISTINCT tags['wikidata'] FROM read_parquet({sql_str(osm_file.as_posix())}) "
                "WHERE tags['wikidata'] IS NOT NULL"
            ).fetchall():
                found.update(q for q in re.split(r"\s*;\s*", value) if QID_RE.match(q))
        wv_file = raw_dir(out, "wikivoyage", date) / f"{city.code}.parquet"
        if "wikivoyage" in available and wv_file.is_file():
            for (value,) in con.execute(
                f"SELECT DISTINCT wikidata FROM read_parquet({sql_str(wv_file.as_posix())}) "
                "WHERE wikidata IS NOT NULL"
            ).fetchall():
                if QID_RE.match(value):
                    found.add(value)
    finally:
        con.close()
    return found


def collect_city(
    city: City,
    *,
    out: Path,
    date: str,
    client: PoliteClient,
    classes: list[str],
    languages: list[str],
) -> list[dict[str, Any]]:
    """Cached radius query + batched detail queries -> one dict per item."""
    cache = raw_dir(out, SOURCE, date) / "_cache"
    radius_rows = _cached_json(
        cache / f"{city.code}.radius.json",
        lambda: sparql(client, radius_query(city, classes)),
    )
    items: dict[str, dict[str, Any]] = {}
    for b in radius_rows:
        qid = qid_of(b["item"]["value"])
        item = items.setdefault(qid, {"via": "radius", "classes": {}})
        item["classes"][qid_of(b["cls"]["value"])] = b.get("clsLabel", {}).get("value")
    linked = sorted(linked_qids(out, date, city) - set(items))
    for qid in linked:
        items[qid] = {"via": "linked", "classes": {}}
    details: dict[str, dict[str, str]] = {}
    for group in (sorted(q for q in items if items[q]["via"] == "radius"), linked):
        for start in range(0, len(group), BATCH_SIZE):
            batch = group[start : start + BATCH_SIZE]
            digest = hashlib.sha1(" ".join(batch).encode()).hexdigest()[:10]
            got = _cached_json(
                cache / f"{city.code}.details.{digest}.json",
                lambda batch=batch: sparql(client, detail_query(batch, languages)),
            )
            for b_ in got:
                details[qid_of(b_["item"]["value"])] = {k: v["value"] for k, v in b_.items()}
    wanted = sorted(items)
    result = []
    for qid in wanted:
        d = details.get(qid, {})
        point = parse_point(d.get("coord"))
        if point is None:
            continue  # no coordinates: cannot be placed
        item = items[qid]
        class_ids = sorted(set(item["classes"]) | set((d.get("classes") or "").split()))
        result.append(
            {
                "qid": qid,
                "via": item["via"],
                "lat": point[0],
                "lon": point[1],
                "sitelinks": int(float(d["sitelinks"])) if d.get("sitelinks") else 0,
                "label_en": d.get("label_en"),
                "label_local": d.get("label_local"),
                "description": d.get("description"),
                "website": d.get("website"),
                "wikipedia_url": d.get("wikipedia"),
                "class_qids": class_ids,
                "class_labels": [item["classes"].get(c) or "" for c in class_ids],
            }
        )
    return result


def write_city_rows(con: duckdb.DuckDBPyConnection, rows_: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    nd = path.with_suffix(".ndjson.tmp")
    nd.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows_) + "\n", encoding="utf-8", newline="\n"
    )
    con.execute(
        f"COPY (SELECT * FROM read_json({sql_str(nd.as_posix())}, format = 'newline_delimited', columns = "
        "{qid: 'VARCHAR', via: 'VARCHAR', lat: 'DOUBLE', lon: 'DOUBLE', sitelinks: 'INTEGER', "
        "label_en: 'VARCHAR', label_local: 'VARCHAR', description: 'VARCHAR', website: 'VARCHAR', "
        "wikipedia_url: 'VARCHAR', class_qids: 'VARCHAR[]', class_labels: 'VARCHAR[]'}) ORDER BY qid) "
        f"TO {sql_str(path.as_posix())} (FORMAT parquet, COMPRESSION zstd)"
    ).fetchall()
    nd.unlink(missing_ok=True)


def extract(
    cities: list[City],
    *,
    out: Path,
    date: str,
    registry: Registry,
    client: PoliteClient | None = None,
    config_dir: Path = CONFIG_DIR,
) -> dict[str, Any]:
    entry = registry.require(SOURCE)
    client = client or PoliteClient(min_interval=MIN_INTERVAL_S, timeout=90, retries=5, backoff=30.0)
    classes = class_qids(config_dir)
    countries = load_countries(config_dir)
    job = ExtractRun(
        source=SOURCE,
        entry=entry,
        out=out,
        date=date,
        version=f"wdqs-{date}",
        dataset_path=ENDPOINT,
        query_template=RADIUS_QUERY.format(
            lon="<lon>",
            lat="<lat>",
            radius_km="<radius_km>",
            classes="wd:<class> ...",
            min_links=MIN_SITELINKS,
        ),
        extra={
            "endpoint": ENDPOINT,
            "user_agent": USER_AGENT,
            "min_interval_seconds": client.min_interval,
            "classes": len(classes),
            "min_sitelinks_for_radius_items": MIN_SITELINKS,
            "usage_policy": "https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual",
        },
    )
    con = connect()
    files: dict[str, dict[str, Any]] = {}
    for city in cities:
        languages = list(countries[city.country].languages) if city.country in countries else []
        items = collect_city(city, out=out, date=date, client=client, classes=classes, languages=languages)
        target = job.directory / f"{city.code}.parquet"
        write_city_rows(con, items, target)
        info = job.file_info(con, city, target)
        info["radius_items"] = sum(1 for i in items if i["via"] == "radius")
        info["linked_items"] = sum(1 for i in items if i["via"] == "linked")
        files[f"{city.code}.parquet"] = info
        log.info(
            "wikidata %s: %d radius items, %d linked", city.code, info["radius_items"], info["linked_items"]
        )
    con.close()
    return job.write_meta(files)


def top_unmapped(
    con: duckdb.DuckDBPyConnection, parquet_glob: str, known: set[str], n: int = 20
) -> list[dict]:
    """Most common classes of radius items that no rule covers (diagnostic)."""
    return rows(
        con,
        f"""SELECT c AS class_qid, any_value(l) AS label, count(*) AS items FROM (
              SELECT unnest(class_qids) c, unnest(class_labels) l FROM read_parquet({sql_str(parquet_glob)})
              WHERE via = 'radius') WHERE c NOT IN (SELECT unnest(?)) GROUP BY c ORDER BY items DESC LIMIT {n}""",
        [sorted(known)],
    )
