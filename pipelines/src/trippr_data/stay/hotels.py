"""Hotels from open data: lodging places in Overture, Foursquare and OpenStreetMap, staged and merged.

Overture and Foursquare are the raw files the places extract already wrote (it keeps every category; the
places staging drops lodging on purpose). OpenStreetMap lodging comes from extract/osm_lodging.py.

Staged tables (staging/<date>/stay/):
  hotel_source.parquet  one row per source record: the staged hotel schema below
  hotel.parquet         one row per hotel after merging the same hotel across and within sources, with the
                        list of source records, the Area it falls in and its distance to the Area centre
"""

from __future__ import annotations

import csv
import json
import logging
import re
from collections import defaultdict
from dataclasses import dataclass
from hashlib import sha1
from pathlib import Path
from typing import Any

import duckdb

from ..cities import City, Country, haversine_km, load_cities, load_countries
from ..duck import connect, rows, run, scalar, sql_str
from ..layout import raw_dir, raw_sources, read_json, write_json
from ..registry import Registry
from ..settings import CONFIG_DIR
from ..stage import PRE_SQL, assign_cities_sql, load_cities_table
from ..taxonomy import EXCLUDE, CategoryMap
from .areas import Area, load_areas
from .config import StayConfig, load_stay_config
from .layout import stay_staging_dir, stay_stats_file, stay_table

log = logging.getLogger(__name__)

HOTEL_SOURCES = ("overture", "foursquare", "osm_lodging")
KINDS = ("hotel", "hostel", "guest_house", "apartment", "resort", "inn", "motel", "other")

# Column order and DuckDB types of hotel_source.parquet.
HOTEL_SOURCE_COLUMNS: dict[str, str] = {
    "source": "VARCHAR",
    "source_id": "VARCHAR",
    "name": "VARCHAR",
    "name_local": "VARCHAR",
    "name_en": "VARCHAR",
    "kind": "VARCHAR",
    "category_source": "VARCHAR",
    "lat": "DOUBLE",
    "lon": "DOUBLE",
    "city_code": "VARCHAR",
    "address": "VARCHAR",
    "website": "VARCHAR",
    "phone": "VARCHAR",
    "stars": "INTEGER",
    "wikidata_qid": "VARCHAR",
    "confidence": "DOUBLE",
    "licence": "VARCHAR",
    "fetched_at": "TIMESTAMP WITH TIME ZONE",
    "raw_ref": "VARCHAR",
}

HOTEL_COLUMNS: dict[str, str] = {
    "hotel_id": "VARCHAR",
    "name": "VARCHAR",
    "name_local": "VARCHAR",
    "name_en": "VARCHAR",
    "kind": "VARCHAR",
    "lat": "DOUBLE",
    "lon": "DOUBLE",
    "city_code": "VARCHAR",
    "address": "VARCHAR",
    "website": "VARCHAR",
    "phone": "VARCHAR",
    "stars": "INTEGER",
    "wikidata_qid": "VARCHAR",
    "confidence": "DOUBLE",
    "sources": "VARCHAR[]",
    "n_sources": "INTEGER",
    "licences": "VARCHAR[]",
    "fetched_at": "TIMESTAMP WITH TIME ZONE",
    "area_id": "VARCHAR",
    "area_dist_km": "DOUBLE",
}

LODGING_FILTER = {
    "overture": "(category_hierarchy[1] = 'lodging' OR category_primary = 'lodging')",
    "foursquare": "category_primary LIKE 'Travel and Transportation > Lodging%'",
    "osm_lodging": "true",
}


def load_kind_maps(config_dir: Path = CONFIG_DIR) -> dict[str, CategoryMap]:
    rules: dict[str, dict[str, str]] = defaultdict(dict)
    path = config_dir / "lodging_kinds.csv"
    with open(path, encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(line for line in fh if line.strip() and not line.startswith("#")):
            source, key, kind = row["source"].strip(), row["source_category"].strip(), row["kind"].strip()
            if kind != EXCLUDE and kind not in KINDS:
                raise ValueError(f"lodging_kinds.csv: unknown kind {kind!r} for {key!r}")
            if key in rules[source]:
                raise ValueError(f"lodging_kinds.csv: duplicate rule for {source}/{key!r}")
            rules[source][key] = kind
    styles = {"overture": "label", "foursquare": "path", "osm_lodging": "label"}
    return {s: CategoryMap(source=s, style=styles[s], rules=r) for s, r in rules.items()}  # type: ignore[arg-type]


@dataclass
class HotelContext:
    cities: list[City]
    countries: dict[str, Country]
    kinds: dict[str, CategoryMap]
    cfg: StayConfig
    areas: list[Area]
    areas_without_centre: list[str]

    @classmethod
    def load(cls, config_dir: Path = CONFIG_DIR, seed_dir: Path | None = None) -> HotelContext:
        cfg = load_stay_config(config_dir)
        kwargs = {"seed_dir": seed_dir} if seed_dir else {}
        areas, missing = load_areas(cfg.areas.default_radius_km, **kwargs)  # type: ignore[arg-type]
        return cls(
            cities=load_cities(config_dir=config_dir),
            countries=load_countries(config_dir),
            kinds=load_kind_maps(config_dir),
            cfg=cfg,
            areas=areas,
            areas_without_centre=missing,
        )


# --- OpenStreetMap -------------------------------------------------------------------------------------

STARS_RE = re.compile(r"^\s*([1-5])")


def osm_stars(value: str | None) -> int | None:
    m = STARS_RE.match(value or "")
    return int(m.group(1)) if m else None


def osm_pre_rows(elements: list[dict[str, Any]], raw_file: str) -> list[dict[str, Any]]:
    """Flatten Overpass elements (out center tags) into the shape the staging SQL expects."""
    out = []
    for el in elements:
        tags = el.get("tags") or {}
        lat = el.get("lat") if el.get("lat") is not None else (el.get("center") or {}).get("lat")
        lon = el.get("lon") if el.get("lon") is not None else (el.get("center") or {}).get("lon")
        if lat is None or lon is None or not tags.get("tourism"):
            continue
        langs = [
            {"language": k[5:], "value": v}
            for k, v in sorted(tags.items())
            if k.startswith("name:") and v and "-" not in k[5:] and "_" not in k[5:]
        ]
        street = " ".join(x for x in (tags.get("addr:housenumber"), tags.get("addr:street")) if x)
        address = ", ".join(x for x in (street, tags.get("addr:city"), tags.get("addr:postcode")) if x)
        out.append(
            {
                "source_id": f"{el.get('type', 'node')}/{el['id']}",
                "name_raw": tags.get("name"),
                "names_by_lang": langs,
                "category_primary": tags["tourism"],
                "lat": float(lat),
                "lon": float(lon),
                "country": (tags.get("addr:country") or "").upper() or None,
                "address": address or None,
                "website": tags.get("website") or tags.get("contact:website"),
                "phone": tags.get("phone") or tags.get("contact:phone"),
                "wikidata_qid": tags.get("wikidata"),
                "stars": osm_stars(tags.get("stars")),
                "closed": False,
                "raw_file": raw_file,
            }
        )
    return out


def _load_osm_pre(con: duckdb.DuckDBPyConnection, directory: Path, meta: dict[str, Any]) -> None:
    rows_: list[dict[str, Any]] = []
    for name in sorted(meta["files"]):
        path = directory / name
        data = json.loads(path.read_text(encoding="utf-8"))
        rows_ += osm_pre_rows(data["elements"], path.as_posix())
    ndjson = directory / "_pre.ndjson.tmp"
    ndjson.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows_), encoding="utf-8")
    try:
        run(
            con,
            f"""CREATE TABLE pre AS SELECT
                  source_id, name_raw, names_by_lang, category_primary,
                  NULL::VARCHAR[] AS category_hierarchy, lat, lon, country, address, website, phone,
                  wikidata_qid, stars, NULL::DOUBLE AS confidence, 'ODbL-1.0' AS licence, closed, raw_file
                FROM read_json({sql_str(ndjson.as_posix())}, format = 'newline_delimited',
                  columns = {{source_id: 'VARCHAR', name_raw: 'VARCHAR',
                              names_by_lang: 'STRUCT("language" VARCHAR, value VARCHAR)[]',
                              category_primary: 'VARCHAR', lat: 'DOUBLE', lon: 'DOUBLE', country: 'VARCHAR',
                              address: 'VARCHAR', website: 'VARCHAR', phone: 'VARCHAR',
                              wikidata_qid: 'VARCHAR', stars: 'INTEGER', closed: 'BOOLEAN',
                              raw_file: 'VARCHAR'}})""",
        )
    finally:
        ndjson.unlink(missing_ok=True)


# --- staging one source --------------------------------------------------------------------------------


def _pre_table(con: duckdb.DuckDBPyConnection, source: str, directory: Path, meta: dict[str, Any]) -> None:
    if source == "osm_lodging":
        _load_osm_pre(con, directory, meta)
        return
    glob = (directory / "*.parquet").as_posix()
    run(
        con,
        f"CREATE VIEW raw AS SELECT * FROM read_parquet({sql_str(glob)}, filename = true, union_by_name = true)",
    )
    run(con, f"CREATE TABLE pre_all AS {PRE_SQL[source]}")
    confidence = "signals.confidence" if source == "overture" else "NULL::DOUBLE"
    run(
        con,
        f"""CREATE TABLE pre AS SELECT source_id, name_raw, names_by_lang, category_primary, category_hierarchy,
              lat, lon, country, address, website, phone, wikidata_qid, NULL::INTEGER AS stars,
              {confidence} AS confidence, licence, closed, raw_file
            FROM pre_all WHERE {LODGING_FILTER[source]}""",
    )


def stage_hotel_source(
    out: Path, date: str, source: str, registry: Registry, ctx: HotelContext
) -> dict[str, Any]:
    """Stage one source's lodging rows. They go to a temporary Parquet beside the final tables, which
    stage_hotels merges across sources; returns the source's stats."""
    entry = registry.require(source)
    directory = raw_dir(out, source, date)
    meta = read_json(directory / "_meta.json")
    extracted = sorted({f["city"] for f in meta["files"].values()})
    cmap = ctx.kinds[source]
    con = connect()
    load_cities_table(con, ctx.cities, ctx.countries)
    _pre_table(con, source, directory, meta)
    run(
        con,
        """CREATE TABLE uniq AS SELECT * FROM pre
           QUALIFY row_number() OVER (PARTITION BY source_id ORDER BY raw_file) = 1""",
    )
    run(con, "CREATE TABLE open_places AS SELECT * FROM uniq WHERE NOT closed")
    run(con, f"CREATE TABLE assigned AS {assign_cities_sql('open_places')}")
    extracted_sql = ", ".join(sql_str(c) for c in extracted)
    run(
        con,
        f"""CREATE TABLE located AS
            SELECT a.*, normalize_name(a.name_raw) AS name,
                   coalesce(a.category_primary, '') || '|' || coalesce(array_to_string(a.category_hierarchy, ' > '), '')
                     AS cat_key
            FROM assigned a WHERE a.country_ok AND a.city_code IN ({extracted_sql})""",
    )
    # Lodging kind per distinct category.
    run(con, "CREATE TABLE kindmap (cat_key VARCHAR, kind VARCHAR, status VARCHAR)")
    resolved = []
    for k in rows(con, "SELECT DISTINCT cat_key, category_primary, category_hierarchy FROM located"):
        kind, status = cmap.resolve(k["category_primary"], k["category_hierarchy"])
        resolved.append([k["cat_key"], kind if status == "mapped" else ("other" if status != "excluded" else None), status])
    if resolved:
        con.executemany("INSERT INTO kindmap VALUES (?, ?, ?)", resolved)

    english = "list_filter(p.names_by_lang, lambda x: x.\"language\" = 'en' OR starts_with(x.\"language\", 'en-'))"
    local = 'list_filter(p.names_by_lang, lambda x: list_contains(c.languages, x."language"))'
    exprs = {
        "source": sql_str(source),
        "source_id": "p.source_id",
        "name": "p.name",
        "name_local": f"coalesce(normalize_name({local}[1].value), CASE WHEN NOT is_latin(p.name) THEN p.name END)",
        "name_en": f"coalesce(normalize_name({english}[1].value), CASE WHEN is_latin(p.name) THEN p.name END)",
        "kind": "p.kind",
        "category_source": "p.category_primary",
        "lat": "round(p.lat, 7)",
        "lon": "round(p.lon, 7)",
        "city_code": "p.city_code",
        "address": "normalize_name(p.address)",
        "website": "nullif(trim(p.website), '')",
        "phone": "nullif(trim(p.phone), '')",
        "stars": "p.stars",
        "wikidata_qid": "nullif(trim(p.wikidata_qid), '')",
        "confidence": "p.confidence",
        "licence": f"coalesce(p.licence, {sql_str(entry.licence)})",
        "fetched_at": "coalesce(f.fetched_at, CAST(? AS TIMESTAMPTZ))",
        "raw_ref": f"{sql_str(f'raw/{source}/{date}/')} || parse_filename(p.raw_file)",
    }
    assert list(exprs) == list(HOTEL_SOURCE_COLUMNS)
    columns = ",\n".join(f"CAST({expr} AS {HOTEL_SOURCE_COLUMNS[col]}) AS {col}" for col, expr in exprs.items())
    run(con, "CREATE TABLE raw_files (file VARCHAR, fetched_at TIMESTAMPTZ)")
    con.executemany(
        "INSERT INTO raw_files VALUES (?, ?)", [[name, f["fetched_at"]] for name, f in meta["files"].items()]
    )
    con.execute(
        f"""CREATE TABLE staged AS
            SELECT {columns}
            FROM (SELECT l.*, m.kind, m.status FROM located l JOIN kindmap m USING (cat_key)) p
            JOIN cities c ON c.code = p.city_code
            LEFT JOIN raw_files f ON f.file = parse_filename(p.raw_file)
            WHERE p.status <> 'excluded' AND p.name IS NOT NULL""",
        [meta["fetched_at"]],
    ).fetchall()
    stats = {
        "source": source,
        "version": meta.get("version"),
        "raw_lodging_rows": scalar(con, "SELECT count(*) FROM pre"),
        "duplicate_rows": scalar(con, "SELECT count(*) FROM pre") - scalar(con, "SELECT count(*) FROM uniq"),
        "closed": scalar(con, "SELECT count(*) FROM uniq WHERE closed"),
        "no_city": scalar(con, "SELECT count(*) FROM assigned WHERE city_code IS NULL"),
        "country_mismatch": scalar(
            con, "SELECT count(*) FROM assigned WHERE city_code IS NOT NULL AND NOT country_ok"
        ),
        "excluded_kind": scalar(con, "SELECT count(*) FROM located l JOIN kindmap m USING (cat_key) WHERE m.status = 'excluded'"),
        "no_name": scalar(
            con,
            "SELECT count(*) FROM located l JOIN kindmap m USING (cat_key) WHERE m.status <> 'excluded' AND l.name IS NULL",
        ),
        "other_kind": scalar(con, "SELECT count(*) FROM staged WHERE kind = 'other'"),
        "staged_rows": scalar(con, "SELECT count(*) FROM staged"),
        "by_kind": dict(run(con, "SELECT kind, count(*) FROM staged GROUP BY 1 ORDER BY 1")),
        "per_city": dict(run(con, "SELECT city_code, count(*) FROM staged GROUP BY 1 ORDER BY 1")),
        "unmapped_top": [
            {"category_source": c, "rows": n}
            for c, n in run(
                con,
                """SELECT coalesce(category_primary, '(none)'), count(*) n FROM located l JOIN kindmap m USING (cat_key)
                   WHERE m.status IN ('unmapped', 'uncategorised') GROUP BY 1 ORDER BY n DESC, 1 LIMIT 15""",
            )
        ],
    }
    # Keep the rows for the merge step in a temp Parquet so the types survive.
    tmp = stay_staging_dir(out, date) / f"_{source}.tmp.parquet"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    run(con, f"COPY staged TO {sql_str(tmp.as_posix())} (FORMAT parquet)")
    con.close()
    log.info("%s lodging: %s raw, %s staged", source, f"{stats['raw_lodging_rows']:,}", f"{stats['staged_rows']:,}")
    return stats


# --- merging -------------------------------------------------------------------------------------------


def _find(parent: dict[int, int], x: int) -> int:
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def cluster_pairs(
    pairs: list[tuple[int, int, float, float]],
    coords: dict[int, tuple[float, float]],
    max_cluster_km: float,
) -> dict[int, int]:
    """Union-find over accepted pairs (a, b, distance_km, similarity), best pairs first. A merge that would
    make a cluster wider than max_cluster_km is skipped. Returns {record: cluster representative}."""
    parent = {k: k for k in coords}
    members: dict[int, list[int]] = {k: [k] for k in coords}
    for a, b, _d, _s in sorted(pairs, key=lambda p: (-p[3], p[2], p[0], p[1])):
        ra, rb = _find(parent, a), _find(parent, b)
        if ra == rb:
            continue
        merged = members[ra] + members[rb]
        if any(
            haversine_km(*coords[x], *coords[y]) > max_cluster_km
            for i, x in enumerate(merged)
            for y in merged[i + 1 :]
        ):
            continue
        lo, hi = (ra, rb) if ra < rb else (rb, ra)
        parent[hi] = lo
        members[lo] = merged
        del members[hi]
    return {k: _find(parent, k) for k in coords}


def hotel_id_for(source: str, source_id: str) -> str:
    return "h_" + sha1(f"{source}:{source_id}".encode()).hexdigest()[:12]


def merge_hotels(
    con: duckdb.DuckDBPyConnection, ctx: HotelContext, precedence: list[str]
) -> dict[str, Any]:
    """From the table hotel_source build hotel_clustered (record -> hotel) and the table hotel."""
    m = ctx.cfg.hotels.merge
    rank_case = " ".join(f"WHEN {sql_str(s)} THEN {i}" for i, s in enumerate(precedence))
    run(
        con,
        f"""CREATE TABLE hs AS SELECT *, row_number() OVER (
              ORDER BY CASE source {rank_case} ELSE 99 END, source_id) AS rk,
              CASE source {rank_case} ELSE 99 END AS prec
            FROM hotel_source""",
    )
    sim = """greatest(
              jaro_winkler_similarity(lower(a.name), lower(b.name)),
              jaro_winkler_similarity(lower(a.name_en), lower(b.name_en)),
              jaro_winkler_similarity(lower(a.name_local), lower(b.name_local)))"""
    cell = 0.003
    candidates = rows(
        con,
        f"""WITH keyed AS (
              SELECT rk, city_code, CAST(floor(lon / {cell}) AS BIGINT) gx, CAST(floor(lat / {cell}) AS BIGINT) gy FROM hs),
            nb AS (
              SELECT rk, city_code, gx + dx AS gx, gy + dy AS gy
              FROM keyed, (SELECT unnest([-1, 0, 1]) AS dx), (SELECT unnest([-1, 0, 1]) AS dy)
            ),
            pairs AS (
              SELECT DISTINCT n.rk AS a_rk, k.rk AS b_rk
              FROM nb n JOIN keyed k ON k.city_code = n.city_code AND k.gx = n.gx AND k.gy = n.gy AND k.rk > n.rk
            )
            SELECT p.a_rk, p.b_rk, a.source = b.source AS same_source,
                   hav_km(a.lat, a.lon, b.lat, b.lon) AS dist_km, {sim} AS sim
            FROM pairs p JOIN hs a ON a.rk = p.a_rk JOIN hs b ON b.rk = p.b_rk
            WHERE hav_km(a.lat, a.lon, b.lat, b.lon) <= {max(m.cross_source_km, m.same_source_km)}""",
    )
    accepted = []
    for c in candidates:
        if c["sim"] is None:
            continue
        if c["same_source"]:
            ok = c["dist_km"] <= m.same_source_km and c["sim"] >= m.same_source_name_similarity
        else:
            ok = c["dist_km"] <= m.cross_source_km and c["sim"] >= m.cross_source_name_similarity
        if ok:
            accepted.append((c["a_rk"], c["b_rk"], c["dist_km"], c["sim"]))
    coords = {r["rk"]: (r["lat"], r["lon"]) for r in rows(con, "SELECT rk, lat, lon FROM hs")}
    rep = cluster_pairs(accepted, coords, m.max_cluster_km)
    run(con, "CREATE TABLE cluster_map (rk BIGINT, rep BIGINT)")
    con.executemany("INSERT INTO cluster_map VALUES (?, ?)", [[k, v] for k, v in rep.items()])
    run(
        con,
        """CREATE TABLE hs2 AS SELECT hs.*, cm.rep,
             min(hs.rk) OVER (PARTITION BY cm.rep) AS first_rk
           FROM hs JOIN cluster_map cm USING (rk)""",
    )
    # hotel_id from the best record of each cluster (the lowest rank = highest-precedence source).
    ids = rows(con, "SELECT rk, source, source_id FROM hs2 WHERE rk = first_rk")
    run(con, "CREATE TABLE hotel_ids (rep BIGINT, hotel_id VARCHAR)")
    con.executemany(
        "INSERT INTO hotel_ids VALUES (?, ?)", [[r["rk"], hotel_id_for(r["source"], r["source_id"])] for r in ids]
    )
    return {
        "candidate_pairs": len(candidates),
        "accepted_pairs": len(accepted),
        "clusters": len(set(rep.values())),
        "records": len(rep),
    }


def _first(col: str, extra: str = "") -> str:
    """The value of col from the highest-precedence record that has one."""
    return f"arg_min({col}, rk) FILTER (WHERE {col} IS NOT NULL{extra})"


def build_hotel_table(con: duckdb.DuckDBPyConnection) -> None:
    run(
        con,
        f"""CREATE TABLE hotel AS
            SELECT
              hid.hotel_id,
              {_first('name')} AS name,
              {_first('name_local')} AS name_local,
              {_first('name_en')} AS name_en,
              coalesce({_first('kind', " AND kind <> 'other'")}, 'other') AS kind,
              arg_min(lat, rk) AS lat,
              arg_min(lon, rk) AS lon,
              arg_min(city_code, rk) AS city_code,
              {_first('address')} AS address,
              {_first('website')} AS website,
              {_first('phone')} AS phone,
              {_first('stars')} AS stars,
              {_first('wikidata_qid')} AS wikidata_qid,
              max(confidence) AS confidence,
              list_sort(list(source || ':' || source_id)) AS sources,
              count(*)::INTEGER AS n_sources,
              list_sort(list_distinct(list(licence))) AS licences,
              max(fetched_at) AS fetched_at
            FROM hs2 JOIN hotel_ids hid ON hid.rep = hs2.rep
            GROUP BY hid.hotel_id""",
    )


def assign_areas(con: duckdb.DuckDBPyConnection, areas: list[Area]) -> None:
    run(
        con,
        "CREATE TABLE area (id VARCHAR, city_code VARCHAR, name VARCHAR, lat DOUBLE, lon DOUBLE, radius_km DOUBLE)",
    )
    if areas:
        con.executemany(
            "INSERT INTO area VALUES (?, ?, ?, ?, ?, ?)",
            [[a.id, a.city_code, a.name, a.lat, a.lon, a.radius_km] for a in areas],
        )
    run(
        con,
        """CREATE TABLE hotel_final AS
           SELECT h.*, b.id AS area_id, round(b.dist_km, 3) AS area_dist_km
           FROM hotel h LEFT JOIN (
             SELECT h2.hotel_id, a.id, hav_km(h2.lat, h2.lon, a.lat, a.lon) AS dist_km
             FROM hotel h2 JOIN area a ON a.city_code = h2.city_code
             WHERE hav_km(h2.lat, h2.lon, a.lat, a.lon) <= a.radius_km
             QUALIFY row_number() OVER (PARTITION BY h2.hotel_id ORDER BY dist_km, a.id) = 1
           ) b USING (hotel_id)""",
    )


def stage_hotels(
    out: Path,
    date: str,
    *,
    registry: Registry,
    sources: list[str] | None = None,
    ctx: HotelContext | None = None,
) -> dict[str, Any]:
    ctx = ctx or HotelContext.load()
    available = [s for s in raw_sources(out, date) if s in HOTEL_SOURCES]
    chosen = [s for s in (sources or available) if s in available]
    if not chosen:
        raise FileNotFoundError(f"No raw lodging data for {date} under {out / 'raw'}; run the extract first")
    precedence = [s for s in ctx.cfg.hotels.source_precedence if s in chosen] + [
        s for s in chosen if s not in ctx.cfg.hotels.source_precedence
    ]
    source_stats = {}
    tmp_files = []
    for source in chosen:
        source_stats[source] = stage_hotel_source(out, date, source, registry, ctx)
        tmp_files.append(stay_staging_dir(out, date) / f"_{source}.tmp.parquet")

    con = connect()
    union = " UNION ALL ".join(f"SELECT * FROM read_parquet({sql_str(f.as_posix())})" for f in tmp_files)
    run(con, f"CREATE TABLE hotel_source AS {union}")
    merge_stats = merge_hotels(con, ctx, precedence)
    build_hotel_table(con)
    assign_areas(con, ctx.areas)

    cols = ", ".join(HOTEL_COLUMNS)
    hotel_path, source_path = stay_table(out, date, "hotel"), stay_table(out, date, "hotel_source")
    hotel_path.parent.mkdir(parents=True, exist_ok=True)
    run(
        con,
        f"COPY (SELECT {cols} FROM hotel_final ORDER BY city_code, hotel_id) TO {sql_str(hotel_path.as_posix())} "
        "(FORMAT parquet, COMPRESSION zstd)",
    )
    source_cols = ", ".join(HOTEL_SOURCE_COLUMNS)
    run(
        con,
        f"""COPY (SELECT hs2.source, hs2.source_id, hid.hotel_id, {source_cols.replace('source, source_id, ', '')}
                  FROM hs2 JOIN hotel_ids hid ON hid.rep = hs2.rep ORDER BY city_code, source, source_id)
            TO {sql_str(source_path.as_posix())} (FORMAT parquet, COMPRESSION zstd)""",
    )
    stats = {
        "run_date": date,
        "sources": source_stats,
        "merge": merge_stats,
        "hotels": scalar(con, "SELECT count(*) FROM hotel_final"),
        "with_area": scalar(con, "SELECT count(*) FROM hotel_final WHERE area_id IS NOT NULL"),
        "with_stars": scalar(con, "SELECT count(*) FROM hotel_final WHERE stars IS NOT NULL"),
        "with_website": scalar(con, "SELECT count(*) FROM hotel_final WHERE website IS NOT NULL"),
        "multi_source": scalar(con, "SELECT count(*) FROM hotel_final WHERE n_sources > 1"),
        "by_kind": dict(run(con, "SELECT kind, count(*) FROM hotel_final GROUP BY 1 ORDER BY 1")),
        "per_city": dict(run(con, "SELECT city_code, count(*) FROM hotel_final GROUP BY 1 ORDER BY 1")),
        "per_area": dict(
            run(con, "SELECT area_id, count(*) FROM hotel_final WHERE area_id IS NOT NULL GROUP BY 1 ORDER BY 1")
        ),
        "areas_without_centre": ctx.areas_without_centre,
    }
    con.close()
    for f in tmp_files:
        f.unlink(missing_ok=True)
    write_json(stay_stats_file(out, date, "hotel"), stats)
    log.info("hotels: %s merged from %s source records", f"{stats['hotels']:,}", f"{merge_stats['records']:,}")
    return stats
