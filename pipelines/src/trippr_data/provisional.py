"""A stand-in for the match stage: golden records straight from staged rows.

Used by curate only when there is no `golden/<date>/golden_place.parquet`. Every staged row becomes its own
golden record, except that a pair of rows from two different sources with the same name (case-folded) within
PROVISIONAL_RADIUS_M of each other, each the other's nearest such row, is merged into one. That is far weaker
than entity resolution (no scripts, no scoring, no QIDs) but it stops the same cafe from Overture and
Foursquare being counted twice. A source listing one place twice (same name within 50 m) keeps only its first row.
Delete this module once the match stage runs in every pipeline run.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import duckdb

from .duck import run, scalar, sql_str
from .golden import GOLDEN_COLUMNS, GOLDEN_SOURCE_TYPE, source_priority_sql
from .schema import SIGNALS_TYPE

PROVISIONAL_RADIUS_M = 75.0
SAME_SOURCE_RADIUS_M = 50.0

# Rough box (about 220 m of latitude) so the haversine runs only on near pairs.
_BOX_DEG = 0.002


def build_provisional_golden(
    con: duckdb.DuckDBPyConnection, staged_files: list[Path], *, merge: bool = True
) -> dict[str, Any]:
    """Create the `golden` table (GOLDEN_COLUMNS) from staged Parquet files; returns counts."""
    files = ", ".join(sql_str(p.as_posix()) for p in staged_files)
    prio = source_priority_sql("source")
    run(
        con,
        f"""CREATE TEMP TABLE st AS
            SELECT row_number() OVER (ORDER BY s.source, s.source_id) AS rid, s.*, lower(trim(s.name)) AS nkey, {prio} AS prio
            FROM read_parquet([{files}], union_by_name = true) s""",
    )
    staged_rows = scalar(con, "SELECT count(*) FROM st")
    # The same source listing one place twice (same name within 50 m): keep the first row.
    run(
        con,
        f"""DELETE FROM st WHERE rid IN (
              SELECT b.rid FROM st a JOIN st b
                ON a.city_code = b.city_code AND a.source = b.source AND a.nkey = b.nkey AND a.rid < b.rid
              WHERE abs(a.lat - b.lat) <= {_BOX_DEG} AND abs(a.lon - b.lon) <= {_BOX_DEG * 2}
                AND hav_km(a.lat, a.lon, b.lat, b.lon) * 1000 <= {SAME_SOURCE_RADIUS_M})""",
    )
    same_source_dupes = staged_rows - scalar(con, "SELECT count(*) FROM st")
    run(con, "CREATE TEMP TABLE pair (lead_rid BIGINT, other_rid BIGINT)")
    if merge:
        run(
            con,
            f"""INSERT INTO pair
                WITH cand AS (
                  SELECT a.rid AS a_rid, b.rid AS b_rid, a.prio AS a_prio, b.prio AS b_prio,
                         hav_km(a.lat, a.lon, b.lat, b.lon) * 1000 AS m
                  FROM st a JOIN st b
                    ON a.city_code = b.city_code AND a.nkey = b.nkey AND a.source < b.source
                  WHERE abs(a.lat - b.lat) <= {_BOX_DEG} AND abs(a.lon - b.lon) <= {_BOX_DEG * 2}
                    AND hav_km(a.lat, a.lon, b.lat, b.lon) * 1000 <= {PROVISIONAL_RADIUS_M}
                ), ranked AS (
                  SELECT *, row_number() OVER (PARTITION BY a_rid ORDER BY m, b_rid) AS ra,
                            row_number() OVER (PARTITION BY b_rid ORDER BY m, a_rid) AS rb
                  FROM cand
                )
                SELECT CASE WHEN a_prio <= b_prio THEN a_rid ELSE b_rid END,
                       CASE WHEN a_prio <= b_prio THEN b_rid ELSE a_rid END
                FROM ranked WHERE ra = 1 AND rb = 1""",
        )
    merged = scalar(con, "SELECT count(*) FROM pair")

    columns = ", ".join(f"{name} {typ}" for name, typ in GOLDEN_COLUMNS.items())
    run(con, f"CREATE OR REPLACE TABLE golden ({columns})")

    def src(alias: str) -> str:
        return (
            f"CAST({{'source': {alias}.source, 'source_id': {alias}.source_id, 'licence': {alias}.licence, "
            f"'fetched_at': {alias}.fetched_at, 'raw_ref': {alias}.raw_ref}} AS {GOLDEN_SOURCE_TYPE})"
        )

    run(
        con,
        f"""INSERT INTO golden
            SELECT 'g-' || substr(sha256(l.source || ':' || l.source_id), 1, 16),
                   l.name,
                   coalesce(l.name_local, o.name_local),
                   coalesce(l.name_en, o.name_en),
                   l.category, l.lat, l.lon, l.city_code,
                   coalesce(l.address, o.address),
                   coalesce(l.website, o.website),
                   coalesce(l.phone, o.phone),
                   coalesce(l.opening_hours, o.opening_hours),
                   coalesce(l.wikidata_qid, o.wikidata_qid),
                   NULL,
                   CAST({{
                     'confidence': greatest(l.signals.confidence, o.signals.confidence),
                     'providers': list_distinct(list_concat(
                         coalesce(l.signals.providers, []), coalesce(o.signals.providers, []))),
                     'brand_wikidata': coalesce(l.signals.brand_wikidata, o.signals.brand_wikidata),
                     'wikidata_sitelinks': greatest(l.signals.wikidata_sitelinks, o.signals.wikidata_sitelinks),
                     'wikivoyage_listed': coalesce(l.signals.wikivoyage_listed, o.signals.wikivoyage_listed)
                   }} AS {SIGNALS_TYPE}),
                   [{src("l")}, {src("o")}]
            FROM pair p JOIN st l ON l.rid = p.lead_rid JOIN st o ON o.rid = p.other_rid""",
    )
    run(
        con,
        f"""INSERT INTO golden
            SELECT 'g-' || substr(sha256(s.source || ':' || s.source_id), 1, 16),
                   s.name, s.name_local, s.name_en, s.category, s.lat, s.lon, s.city_code,
                   s.address, s.website, s.phone, s.opening_hours, s.wikidata_qid, NULL,
                   s.signals, [{src("s")}]
            FROM st s
            WHERE s.rid NOT IN (SELECT lead_rid FROM pair UNION ALL SELECT other_rid FROM pair)""",
    )
    return {
        "staged_rows": staged_rows,
        "same_source_duplicates": same_source_dupes,
        "merged_pairs": merged,
        "golden_rows": staged_rows - same_source_dupes - merged,
    }
