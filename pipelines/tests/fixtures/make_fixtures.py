"""Rebuild the checked-in test fixtures from a real local extract.

    uv run python tests/fixtures/make_fixtures.py --raw out/raw/overture/2026-11-22

Samples a few hundred Overture rows for Tokyo and Osaka (deterministically, by a hash of the id) and
derives a small Foursquare-schema fixture from the sampled rows that Overture credits to Foursquare.
See README.md in this folder for what is real and what is synthetic.
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
INTERESTING = (
    "buddhist_place_of_worship",
    "shrine",
    "museum",
    "art_museum",
    "park",
    "botanical_garden",
    "onsen",
    "public_bath_house",
    "hiking_trail",
    "mountain",
    "castle",
    "aquarium",
    "zoo",
    "arcade",
    "karaoke_venue",
    "electronics_store",
    "tour_operator",
    "historic_site",
    "art_gallery",
    "amusement_park",
    "farmers_market",
    "bakery",
    "coffee_shop",
    "cafe",
    "sake_bar",
    "stadium_arena",
    "golf_course",
    "music_venue",
)

# Overture label -> a Foursquare label, for the synthetic Foursquare rows.
FSQ_LABELS = [
    ("buddhist_place_of_worship", "Community and Government > Spiritual Center > Buddhist Temple"),
    ("shrine", "Community and Government > Spiritual Center > Shrine"),
    ("museum", "Arts and Entertainment > Museum > History Museum"),
    ("park", "Landmarks and Outdoors > Park"),
    ("coffee_shop", "Dining and Drinking > Cafe, Coffee, and Tea House > Coffee Shop"),
    ("cafe", "Dining and Drinking > Cafe, Coffee, and Tea House > Café"),
    ("bakery", "Dining and Drinking > Bakery"),
    ("bar", "Dining and Drinking > Bar > Sake Bar"),
    ("restaurant", "Dining and Drinking > Restaurant > Asian Restaurant > Japanese Restaurant"),
    ("casual_eatery", "Dining and Drinking > Restaurant"),
    ("shopping", "Retail > Clothing Store"),
    ("health_care", "Health and Medicine > Doctor's Office"),
    ("services_and_business", "Business and Professional Services > Office"),
]
FSQ_FALLBACK = "Landmarks and Outdoors > Structure"  # deliberately unmapped


def sample_overture(con: duckdb.DuckDBPyConnection, src: Path, dst: Path) -> None:
    interesting = ", ".join(f"'{x}'" for x in INTERESTING)
    con.execute(
        f"""
        COPY (
          WITH r AS (SELECT *, hash(id) h FROM read_parquet('{src.as_posix()}')),
          by_top AS (SELECT * FROM r QUALIFY row_number() OVER (PARTITION BY taxonomy.hierarchy[1] ORDER BY h) <= 7),
          by_label AS (SELECT * FROM r WHERE taxonomy."primary" IN ({interesting})
                       QUALIFY row_number() OVER (PARTITION BY taxonomy."primary" ORDER BY h) <= 2),
          english AS (SELECT * FROM r WHERE len(names.rules) > 0 AND taxonomy.hierarchy[1] IN ('food_and_drink', 'arts_and_entertainment')
                      ORDER BY h LIMIT 4),
          closed AS (SELECT * FROM r WHERE operating_status = 'permanently_closed' ORDER BY h LIMIT 2),
          edge AS (SELECT * FROM r ORDER BY bbox.xmin + bbox.ymin, h LIMIT 3)
          SELECT DISTINCT ON (id) * EXCLUDE (h) FROM (
            SELECT * FROM by_top UNION ALL SELECT * FROM by_label UNION ALL SELECT * FROM english
            UNION ALL SELECT * FROM closed UNION ALL SELECT * FROM edge)
          ORDER BY id
        ) TO '{dst.as_posix()}' (FORMAT parquet, COMPRESSION zstd)
        """
    ).fetchall()


def foursquare_rows(con: duckdb.DuckDBPyConnection, ov: Path, dst: Path, extra_sql: str = "") -> None:
    cases = " ".join(
        f"WHEN list_contains(taxonomy.hierarchy, '{label}') OR taxonomy.\"primary\" = '{label}' THEN '{fsq.replace("'", "''")}'"
        for label, fsq in FSQ_LABELS
    )
    con.execute(
        f"""
        COPY (
          SELECT * FROM (
            SELECT
              list_filter(sources, lambda s: s.dataset = 'Foursquare')[1].record_id AS fsq_place_id,
              names."primary" AS name,
              bbox.ymin AS latitude, bbox.xmin AS longitude,
              addresses[1].freeform AS address, addresses[1].locality AS locality, NULL::VARCHAR AS region,
              addresses[1].postcode AS postcode, NULL::VARCHAR AS admin_region, addresses[1].country AS country,
              NULL::DATE AS date_created, DATE '2026-01-01' AS date_refreshed, NULL::DATE AS date_closed,
              phones[1] AS tel, websites[1] AS website,
              ['fixture'] AS fsq_category_ids,
              [CASE {cases} ELSE '{FSQ_FALLBACK}' END] AS fsq_category_labels
            FROM read_parquet('{ov.as_posix()}')
            WHERE list_contains(list_transform(sources, lambda s: s.dataset), 'Foursquare')
            {extra_sql}
          ) ORDER BY fsq_place_id
        ) TO '{dst.as_posix()}' (FORMAT parquet, COMPRESSION zstd)
        """
    ).fetchall()


def write_meta(directory: Path, source: str, version: str, licence: str, path: str) -> None:
    files = {}
    for f in sorted(directory.glob("*.parquet")):
        rows = (
            duckdb.connect().execute(f"SELECT count(*) FROM read_parquet('{f.as_posix()}')").fetchall()[0][0]
        )
        files[f.name] = {"city": f.stem, "rows": rows, "sha256": sha256_file(f), "fetched_at": FETCHED_AT}
    write_json(
        directory / "_meta.json",
        {
            "source": source,
            "licence": licence,
            "version": version,
            "dataset_path": path,
            "run_date": FIXTURE_DATE,
            "fetched_at": FETCHED_AT,
            "row_count": sum(f["rows"] for f in files.values()),
            "fixture": True,
            "files": files,
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", type=Path, required=True, help="a real raw/overture/<date> folder")
    parser.add_argument("--release", default="2026-11-18.0")
    args = parser.parse_args()

    out = HERE / "data"
    if out.exists():
        shutil.rmtree(out)
    ov_dir = out / "raw" / "overture" / FIXTURE_DATE
    fsq_dir = out / "raw" / "foursquare" / FIXTURE_DATE
    ov_dir.mkdir(parents=True)
    fsq_dir.mkdir(parents=True)
    con = duckdb.connect()
    for city in CITIES:
        sample_overture(con, args.raw / f"{city}.parquet", ov_dir / f"{city}.parquet")

    # Synthetic edge cases on top of the derived rows: a closed place, a row repeated in both city
    # files (dedupe), and a row whose address names another country (country check).
    foursquare_rows(con, ov_dir / "TYO.parquet", fsq_dir / "TYO.parquet")
    foursquare_rows(con, ov_dir / "OSA.parquet", fsq_dir / "OSA.parquet")
    con.execute(
        f"""
        CREATE TABLE tyo AS SELECT * FROM read_parquet('{(fsq_dir / "TYO.parquet").as_posix()}');
        CREATE TABLE osa AS SELECT * FROM read_parquet('{(fsq_dir / "OSA.parquet").as_posix()}');
        UPDATE tyo SET date_closed = DATE '2026-03-01' WHERE fsq_place_id = (SELECT min(fsq_place_id) FROM tyo);
        INSERT INTO osa SELECT * FROM tyo WHERE fsq_place_id = (SELECT max(fsq_place_id) FROM tyo);
        INSERT INTO tyo SELECT * REPLACE ('fixture-wrong-country' AS fsq_place_id, 'KR' AS country)
          FROM osa ORDER BY fsq_place_id LIMIT 1;
        UPDATE tyo SET latitude = 35.6812, longitude = 139.7671 WHERE fsq_place_id = 'fixture-wrong-country';
        COPY (SELECT * FROM tyo ORDER BY fsq_place_id) TO '{(fsq_dir / "TYO.parquet").as_posix()}' (FORMAT parquet);
        COPY (SELECT * FROM osa ORDER BY fsq_place_id) TO '{(fsq_dir / "OSA.parquet").as_posix()}' (FORMAT parquet);
        """
    ).fetchall()
    write_meta(
        ov_dir,
        "overture",
        args.release,
        "CDLA-Permissive-2.0 AND Apache-2.0 AND CC0-1.0",
        f"s3://overturemaps-us-west-2/release/{args.release}/theme=places/type=place/*",
    )
    write_meta(fsq_dir, "foursquare", "fixture", "Apache-2.0", "synthetic (see README.md)")


if __name__ == "__main__":
    main()
