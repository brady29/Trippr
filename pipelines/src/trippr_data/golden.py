"""The golden records curate works on, and how they are read from the match stage's output.

The match stage (`match.py`) writes `matched/<date>/golden.parquet`: one row per real-world place with
field-level survivorship and its `sources[]`. Curate needs only a slice of that, held in one internal
`golden` table (GOLDEN_COLUMNS below). `from_matched` fills it from golden.parquet; `provisional.py` fills it
from staged rows when there is no match output. Everything after that (score, budget, mix, bundle) reads
the `golden` table only, so a change to the match output's extra columns does not touch curation.
"""

from __future__ import annotations

import duckdb

from .duck import rows, run, sql_str

GOLDEN_SIGNALS_TYPE = (
    "STRUCT(confidence DOUBLE, wikidata_sitelinks INTEGER, wikivoyage_listed BOOLEAN, brand_wikidata VARCHAR)"
)
GOLDEN_SOURCE_TYPE = (
    "STRUCT(source VARCHAR, source_id VARCHAR, licence VARCHAR, "
    "fetched_at TIMESTAMP WITH TIME ZONE, raw_ref VARCHAR)"
)

# Column order and DuckDB types of the internal `golden` table.
GOLDEN_COLUMNS: dict[str, str] = {
    "golden_id": "VARCHAR",
    "name": "VARCHAR",
    "name_local": "VARCHAR",
    "name_en": "VARCHAR",
    "category": "VARCHAR",
    "lat": "DOUBLE",
    "lon": "DOUBLE",
    "city_code": "VARCHAR",
    "address": "VARCHAR",
    "website": "VARCHAR",
    "phone": "VARCHAR",
    "opening_hours": "VARCHAR",
    "wikidata_qid": "VARCHAR",
    "description": "VARCHAR",
    # Merged over the cluster: best confidence, most Wikidata sitelinks, listed in Wikivoyage in any.
    "signals": GOLDEN_SIGNALS_TYPE,
    "sources": f"{GOLDEN_SOURCE_TYPE}[]",
}

# The columns of matched/<date>/golden.parquet that curate reads (the file has more).
MATCHED_REQUIRED = (
    "golden_id",
    "city_code",
    "name",
    "name_en",
    "name_local",
    "category",
    "lat",
    "lon",
    "address",
    "website",
    "phone",
    "opening_hours",
    "wikidata_qid",
    "description",
    "wikidata_sitelinks",
    "wikivoyage_listed",
    "confidence",
    "sources",
)

# Which source wins when two records disagree, and which one a place's stable id is built from
# (best first). Matches the spec's survivorship: names from Wikidata/Wikivoyage, coordinates and
# websites from OSM/Overture.
SOURCE_PRIORITY = ("wikidata", "wikivoyage", "osm", "overture", "foursquare")


def source_priority_sql(column: str = "source") -> str:
    """A SQL CASE giving each source its rank in SOURCE_PRIORITY (unknown sources last)."""
    whens = " ".join(f"WHEN '{s}' THEN {i}" for i, s in enumerate(SOURCE_PRIORITY, start=1))
    return f"(CASE {column} {whens} ELSE {len(SOURCE_PRIORITY) + 1} END)"


def from_matched(con: duckdb.DuckDBPyConnection, path: str, staged_files: list[str] | None = None) -> int:
    """Create the `golden` table from the match stage's golden.parquet; returns the row count.

    The matched file has no brand information, so when the staged files are given a place gets the Overture
    brand Wikidata id (a chain) of any of its source records, for the ranking's chain penalty."""
    run(con, f"CREATE OR REPLACE VIEW matched AS SELECT * FROM read_parquet({sql_str(path)})")
    present = {r["column_name"] for r in rows(con, "DESCRIBE matched")}
    missing = [c for c in MATCHED_REQUIRED if c not in present]
    if missing:
        raise ValueError(f"{path} is not a golden.parquet from the match stage: missing columns {missing}")
    if staged_files:
        files = ", ".join(sql_str(f) for f in staged_files)
        run(
            con,
            f"""CREATE OR REPLACE VIEW brands AS
                SELECT m.golden_id, any_value(s.signals.brand_wikidata) AS brand
                FROM (SELECT golden_id, unnest(sources) AS member FROM matched) m
                JOIN read_parquet([{files}], union_by_name = true) s
                  ON s.source = m.member.source AND s.source_id = m.member.source_id
                WHERE s.signals.brand_wikidata IS NOT NULL
                GROUP BY m.golden_id""",
        )
    else:
        run(
            con,
            "CREATE OR REPLACE VIEW brands AS SELECT NULL::VARCHAR AS golden_id, NULL::VARCHAR AS brand WHERE false",
        )
    columns = ", ".join(f"{name} {typ}" for name, typ in GOLDEN_COLUMNS.items())
    run(con, f"CREATE OR REPLACE TABLE golden ({columns})")
    run(
        con,
        f"""INSERT INTO golden
            SELECT m.golden_id, name, name_local, name_en, category, lat, lon, city_code, address, website, phone,
                   opening_hours, wikidata_qid, description,
                   CAST({{'confidence': confidence, 'wikidata_sitelinks': wikidata_sitelinks,
                          'wikivoyage_listed': wikivoyage_listed, 'brand_wikidata': b.brand}} AS {GOLDEN_SIGNALS_TYPE}),
                   list_transform(sources, lambda s: CAST({{'source': s.source, 'source_id': s.source_id,
                       'licence': s.licence, 'fetched_at': s.fetched_at, 'raw_ref': s.raw_ref}}
                       AS {GOLDEN_SOURCE_TYPE}))
            FROM matched m LEFT JOIN brands b ON b.golden_id = m.golden_id""",
    )
    return int(run(con, "SELECT count(*) FROM golden")[0][0])
