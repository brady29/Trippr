"""Rebuild the OSM, Wikidata and Wikivoyage test fixtures from a real local extract.

    uv run python tests/fixtures/make_source_fixtures.py --raw out/raw --date 2026-11-22

For Tokyo and Osaka it keeps real rows that lie within 200 m of a fixture Overture or Foursquare place
(so the golden test has places that really are in several sources), plus a small hash-ordered sample of
the rest, in the exact shape `extract` writes. See README.md in this folder.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import duckdb

from trippr_data.extract.common import sha256_file
from trippr_data.layout import write_json

HERE = Path(__file__).resolve().parent
FIXTURE_DATE = "2026-11-18"
FETCHED_AT = "2026-11-18T00:00:00+00:00"
CITIES = ("TYO", "OSA")
NEAR = 5
EXTRA = 12
SOURCES = {
    "osm": ("ODbL-1.0", "overpass", "lat", "lon"),
    "wikidata": ("CC0-1.0", "wdqs", "lat", "lon"),
    "wikivoyage": ("CC-BY-SA-4.0", "enwikivoyage", "lat", "lon"),
}


def sample(con: duckdb.DuckDBPyConnection, src: Path, anchors: list[Path], dst: Path, key: str) -> None:
    anchor_sql = " UNION ALL ".join(
        f"SELECT bbox.ymin AS y, bbox.xmin AS x FROM read_parquet('{a.as_posix()}')"
        if "overture" in a.as_posix()
        else f"SELECT latitude AS y, longitude AS x FROM read_parquet('{a.as_posix()}')"
        for a in anchors
    )
    con.execute(
        f"""
        COPY (
          WITH r AS (SELECT *, hash({key}) AS h FROM read_parquet('{src.as_posix()}') WHERE lat IS NOT NULL),
          a AS ({anchor_sql}),
          near AS (SELECT DISTINCT r.h FROM r JOIN a ON abs(r.lat - a.y) < 0.0018 AND abs(r.lon - a.x) < 0.0022
                   WHERE 1000 * 2 * 6371.0088 * asin(sqrt(pow(sin(radians(r.lat - a.y) / 2), 2)
                     + cos(radians(a.y)) * cos(radians(r.lat)) * pow(sin(radians(r.lon - a.x) / 2), 2))) < 200),
          picked AS (
            SELECT * FROM r WHERE h IN (SELECT h FROM near) QUALIFY row_number() OVER (ORDER BY h) <= {NEAR * 8}
            UNION
            SELECT * FROM r ORDER BY h LIMIT {EXTRA})
          SELECT * EXCLUDE (h) FROM picked ORDER BY {key}
        ) TO '{dst.as_posix()}' (FORMAT parquet, COMPRESSION zstd)
        """
    ).fetchall()


# Overture label -> (OSM tags, Wikidata class, Wikivoyage listing type) for the synthetic rows
DERIVE = {
    "buddhist_place_of_worship": ({"amenity": "place_of_worship", "religion": "buddhist"}, "Q5393308", "see"),
    "shrine": ({"amenity": "place_of_worship", "religion": "shinto"}, "Q845945", "see"),
    "museum": ({"tourism": "museum"}, "Q33506", "see"),
    "art_museum": ({"tourism": "museum"}, "Q207694", "see"),
    "park": ({"leisure": "park"}, "Q22698", "see"),
    "botanical_garden": ({"leisure": "garden", "garden:type": "botanical"}, "Q167346", "see"),
    "castle": ({"historic": "castle"}, "Q23413", "see"),
    "aquarium": ({"tourism": "aquarium"}, "Q2281788", "see"),
    "amusement_park": ({"tourism": "theme_park"}, "Q194195", "do"),
}
OFFSET_DEG = 0.00035  # about 30 to 40 m


def derive_rows(con: duckdb.DuckDBPyConnection, city: str) -> dict[str, list[dict]]:
    """Synthetic OSM, Wikidata and Wikivoyage rows for places that are also in the Overture fixture."""
    labels = ", ".join(f"'{k}'" for k in DERIVE)
    src = HERE / "data" / "raw" / "overture" / FIXTURE_DATE / f"{city}.parquet"
    found = con.execute(
        f"""SELECT id, names."primary", taxonomy."primary", bbox.ymin, bbox.xmin,
                   list_filter(names.rules, lambda r: r."language" = 'en')[1].value
            FROM read_parquet('{src.as_posix()}') WHERE taxonomy."primary" IN ({labels})
            ORDER BY hash(id) LIMIT 9"""
    ).fetchall()
    out: dict[str, list[dict]] = {"osm": [], "wikidata": [], "wikivoyage": []}
    for i, (pid, name, label, lat, lon, english) in enumerate(found):
        tags, cls, listing = DERIVE[label]
        qid = f"Q9{10000 + i + (0 if city == 'TYO' else 100)}"
        latin = name.isascii()
        if i % 3 != 2:  # OSM: local name, English name when known, a QID on some
            osm_tags = {"name": name, **tags}
            if english or latin:
                osm_tags["name:en"] = english or name
            if i % 3 == 0:
                osm_tags["wikidata"] = qid
            out["osm"].append(
                {
                    "osm_type": "node",
                    "osm_id": 9_000_000 + i,
                    "lat": lat + OFFSET_DEG,
                    "lon": lon,
                    "tags": osm_tags,
                }
            )
        if i % 3 != 1:  # Wikidata: labels in both scripts, a sitelink count
            out["wikidata"].append(
                {
                    "qid": qid,
                    "via": "radius",
                    "lat": lat,
                    "lon": lon + OFFSET_DEG,
                    "sitelinks": 3 + i,
                    "label_en": english or (name if latin else None),
                    "label_local": None if latin else name,
                    "description": "fixture description",
                    "website": None,
                    "wikipedia_url": None,
                    "class_qids": [cls],
                    "class_labels": [""],
                }
            )
        if i % 3 != 0:  # Wikivoyage: English name, local name in `alt`, text under CC BY-SA
            out["wikivoyage"].append(
                {
                    "source_id": f"9{i}:fixture{i}",
                    "page_id": 9000 + i,
                    "article": city,
                    "article_city": city,
                    "revision": "2026-11-01T00:00:00Z",
                    "listing_type": listing,
                    "listing_index": i,
                    "name": english or name,
                    "alt": None if latin else name,
                    "url": None,
                    "address": None,
                    "lat": lat - OFFSET_DEG,
                    "lon": lon,
                    "phone": None,
                    "hours": None,
                    "wikidata": qid if i % 3 == 1 else None,
                    "wikipedia": None,
                    "last_edit": None,
                    "content": "Fixture text standing in for a Wikivoyage description.",
                }
            )
    return out


def write_rows(con: duckdb.DuckDBPyConnection, source: str, rows: list[dict], dst: Path) -> None:
    import json

    columns = {
        "osm": "{osm_type: 'VARCHAR', osm_id: 'BIGINT', lat: 'DOUBLE', lon: 'DOUBLE', tags: 'MAP(VARCHAR, VARCHAR)'}",
        "wikidata": "{qid: 'VARCHAR', via: 'VARCHAR', lat: 'DOUBLE', lon: 'DOUBLE', sitelinks: 'INTEGER', "
        "label_en: 'VARCHAR', label_local: 'VARCHAR', description: 'VARCHAR', website: 'VARCHAR', "
        "wikipedia_url: 'VARCHAR', class_qids: 'VARCHAR[]', class_labels: 'VARCHAR[]'}",
        "wikivoyage": "{source_id: 'VARCHAR', page_id: 'BIGINT', article: 'VARCHAR', article_city: 'VARCHAR', "
        "revision: 'VARCHAR', listing_type: 'VARCHAR', listing_index: 'INTEGER', name: 'VARCHAR', alt: 'VARCHAR', "
        "url: 'VARCHAR', address: 'VARCHAR', lat: 'DOUBLE', lon: 'DOUBLE', phone: 'VARCHAR', hours: 'VARCHAR', "
        "wikidata: 'VARCHAR', wikipedia: 'VARCHAR', last_edit: 'VARCHAR', content: 'VARCHAR'}",
    }[source]
    nd = dst.with_suffix(".ndjson")
    nd.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
    con.execute(
        f"COPY (SELECT * FROM read_json('{nd.as_posix()}', format = 'newline_delimited', columns = {columns})) "
        f"TO '{dst.as_posix()}' (FORMAT parquet, COMPRESSION zstd)"
    ).fetchall()
    nd.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", type=Path, required=True, help="a real out/raw folder")
    parser.add_argument("--date", default="2026-11-22")
    args = parser.parse_args()
    out = HERE / "data" / "raw"
    con = duckdb.connect()
    keys = {"osm": "osm_type || osm_id", "wikidata": "qid", "wikivoyage": "source_id"}
    for source, (licence, version, *_rest) in SOURCES.items():
        target = out / source / FIXTURE_DATE
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True)
        files = {}
        for city in CITIES:
            src = args.raw / source / args.date / f"{city}.parquet"
            if not src.is_file():
                continue
            anchors = [out / s / FIXTURE_DATE / f"{city}.parquet" for s in ("overture", "foursquare")]
            dst = target / f"{city}.parquet"
            sample(con, src, anchors, dst, keys[source])
            # the real sample above is merged with synthetic rows derived from the Overture fixture
            real = dst.with_name(f"{city}.real.parquet")
            dst.replace(real)
            synthetic = derive_rows(con, city)[source]
            tmp = dst.with_name(f"{city}.synthetic.parquet")
            write_rows(con, source, synthetic, tmp)
            con.execute(
                f"COPY (SELECT * FROM read_parquet(['{real.as_posix()}', '{tmp.as_posix()}'], union_by_name = true) "
                f"ORDER BY {keys[source]}) TO '{dst.as_posix()}' (FORMAT parquet, COMPRESSION zstd)"
            ).fetchall()
            real.unlink()
            tmp.unlink()
            rows = con.execute(f"SELECT count(*) FROM read_parquet('{dst.as_posix()}')").fetchone()[0]
            files[dst.name] = {
                "city": city,
                "rows": rows,
                "sha256": sha256_file(dst),
                "fetched_at": FETCHED_AT,
            }
        write_json(
            target / "_meta.json",
            {
                "source": source,
                "licence": licence,
                "version": f"{version}-fixture",
                "run_date": FIXTURE_DATE,
                "fetched_at": FETCHED_AT,
                "row_count": sum(f["rows"] for f in files.values()),
                "fixture": True,
                "files": files,
            },
        )


if __name__ == "__main__":
    main()
