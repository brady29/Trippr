"""Stage: map each source's raw rows onto the common staged_place schema.

Steps per source: read the raw city files, keep one row per source id, drop closed places, assign the
nearest Trippr city within its radius (preferring a city in the record's own country), normalise names,
map categories through the source's CSV, and write staging/<date>/<source>.parquet plus a stats file.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb

from .cities import City, Country, load_cities, load_countries
from .duck import connect, rows, run, scalar, sql_str
from .layout import raw_dir, raw_sources, read_json, stage_stats_file, staged_file, write_json
from .registry import Registry, SourceEntry
from .schema import SIGNALS_TYPE, STAGED_COLUMNS
from .settings import CONFIG_DIR
from .taxonomy import Category, CategoryMap, load_category_map, load_taxonomy

log = logging.getLogger(__name__)

# Each source's raw columns projected onto one intermediate shape ("pre").
PRE_SQL: dict[str, str] = {
    "overture": f"""
        SELECT
          id AS source_id,
          names."primary" AS name_raw,
          list_transform(
            list_filter(names.rules, lambda r: r.value IS NOT NULL AND r."language" IS NOT NULL
                                         AND coalesce(r.variant, '') <> 'short' AND r."between" IS NULL),
            lambda r: struct_pack("language" := r."language", value := r.value)
          ) AS names_by_lang,
          coalesce(taxonomy."primary", basic_category) AS category_primary,
          taxonomy.hierarchy AS category_hierarchy,
          (bbox.ymin + bbox.ymax) / 2 AS lat,
          (bbox.xmin + bbox.xmax) / 2 AS lon,
          addresses[1].country AS country,
          nullif(concat_ws(', ', addresses[1].freeform, addresses[1].locality, addresses[1].postcode), '')
            AS address,
          websites[1] AS website,
          phones[1] AS phone,
          NULL::VARCHAR AS opening_hours,
          NULL::VARCHAR AS wikidata_qid,
          struct_pack(
            confidence := confidence,
            providers := list_sort(list_distinct(list_transform(
              list_filter(sources, lambda s: s.dataset NOT IN ('Overture', 'Overture-signals')), lambda s: s.dataset))),
            brand_wikidata := brand.wikidata,
            wikidata_sitelinks := NULL::INTEGER,
            wikivoyage_listed := NULL::BOOLEAN
          )::{SIGNALS_TYPE} AS signals,
          nullif(array_to_string(list_sort(list_distinct(list_transform(
            list_filter(sources, lambda s: s.dataset NOT IN ('Overture', 'Overture-signals') AND s.license IS NOT NULL),
            lambda s: s.license))), ' AND '), '') AS licence,
          coalesce(operating_status = 'permanently_closed', false) AS closed,
          filename AS raw_file
        FROM raw
    """,
    "foursquare": f"""
        SELECT
          fsq_place_id AS source_id,
          name AS name_raw,
          NULL::STRUCT("language" VARCHAR, value VARCHAR)[] AS names_by_lang,
          fsq_category_labels[1] AS category_primary,
          NULL::VARCHAR[] AS category_hierarchy,
          latitude::DOUBLE AS lat,
          longitude::DOUBLE AS lon,
          country,
          nullif(concat_ws(', ', address, locality, postcode), '') AS address,
          website,
          tel AS phone,
          NULL::VARCHAR AS opening_hours,
          NULL::VARCHAR AS wikidata_qid,
          struct_pack(
            confidence := NULL::DOUBLE,
            providers := ['foursquare'],
            brand_wikidata := NULL::VARCHAR,
            wikidata_sitelinks := NULL::INTEGER,
            wikivoyage_listed := NULL::BOOLEAN
          )::{SIGNALS_TYPE} AS signals,
          'Apache-2.0' AS licence,
          date_closed IS NOT NULL AS closed,
          filename AS raw_file
        FROM raw
    """,
}


@dataclass
class StageContext:
    cities: list[City]
    countries: dict[str, Country]
    taxonomy: dict[str, Category]
    config_dir: Path = CONFIG_DIR

    @classmethod
    def load(cls, config_dir: Path = CONFIG_DIR) -> StageContext:
        return cls(
            load_cities(config_dir=config_dir),
            load_countries(config_dir),
            load_taxonomy(config_dir),
            config_dir,
        )


def load_cities_table(
    con: duckdb.DuckDBPyConnection, cities: Iterable[City], countries: dict[str, Country]
) -> None:
    run(
        con,
        """CREATE OR REPLACE TABLE cities (code VARCHAR, country VARCHAR, lat DOUBLE, lon DOUBLE,
           radius_km DOUBLE, min_lon DOUBLE, min_lat DOUBLE, max_lon DOUBLE, max_lat DOUBLE, languages VARCHAR[])""",
    )
    con.executemany(
        "INSERT INTO cities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            [
                c.code,
                c.country,
                c.lat,
                c.lon,
                c.radius_km,
                *c.bbox,
                list(countries[c.country].languages) if c.country in countries else [],
            ]
            for c in cities
        ],
    )


def assign_cities_sql(source_table: str) -> str:
    """Nearest Trippr city within its radius, preferring cities in the record's own country.

    Adds city_code (NULL when no city is in range) and country_ok (false when the record names a
    different country than every city in range, e.g. a Zhuhai shop inside Macau's circle).
    """
    return f"""
        WITH cand AS (
          SELECT p.source_id, c.code, c.country AS city_country,
                 hav_km(p.lat, p.lon, c.lat, c.lon) AS dist_km, c.radius_km,
                 (p.country IS NOT NULL AND p.country = c.country) AS same_country
          FROM {source_table} p
          JOIN cities c ON p.lat BETWEEN c.min_lat AND c.max_lat AND p.lon BETWEEN c.min_lon AND c.max_lon
        ),
        best AS (
          SELECT source_id, code, city_country, dist_km FROM cand
          WHERE dist_km <= radius_km
          QUALIFY row_number() OVER (PARTITION BY source_id ORDER BY same_country DESC, dist_km, code) = 1
        )
        SELECT p.*, b.code AS city_code, b.dist_km AS city_dist_km,
               (b.code IS NOT NULL AND (p.country IS NULL OR p.country = b.city_country)) AS country_ok
        FROM {source_table} p LEFT JOIN best b USING (source_id)
    """


def _category_table(con: duckdb.DuckDBPyConnection, cmap: CategoryMap) -> None:
    keys = rows(con, "SELECT DISTINCT cat_key, category_primary, category_hierarchy FROM located")
    run(con, "CREATE OR REPLACE TABLE catmap (cat_key VARCHAR, category VARCHAR, status VARCHAR)")
    resolved = []
    for k in keys:
        category, status = cmap.resolve(k["category_primary"], k["category_hierarchy"])
        resolved.append([k["cat_key"], category, status])
    if resolved:
        con.executemany("INSERT INTO catmap VALUES (?, ?, ?)", resolved)


def stage_source(out: Path, date: str, source: str, entry: SourceEntry, ctx: StageContext) -> dict[str, Any]:
    directory = raw_dir(out, source, date)
    meta = read_json(directory / "_meta.json")
    extracted = sorted({f["city"] for f in meta["files"].values()})
    raw_glob = (directory / "*.parquet").as_posix()
    cmap = load_category_map(source, ctx.taxonomy, ctx.config_dir)

    con = connect()
    load_cities_table(con, ctx.cities, ctx.countries)
    run(con, "CREATE TABLE raw_files (file VARCHAR, fetched_at TIMESTAMPTZ)")
    con.executemany(
        "INSERT INTO raw_files VALUES (?, ?)", [[name, f["fetched_at"]] for name, f in meta["files"].items()]
    )
    run(
        con,
        f"CREATE VIEW raw AS SELECT * FROM read_parquet({sql_str(raw_glob)}, filename = true, union_by_name = true)",
    )
    run(con, f"CREATE TABLE pre AS {PRE_SQL[source]}")
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
            FROM assigned a
            WHERE a.country_ok AND a.city_code IN ({extracted_sql})""",
    )
    _category_table(con, cmap)
    run(
        con,
        "CREATE TABLE categorised AS SELECT l.*, m.category, m.status FROM located l JOIN catmap m USING (cat_key)",
    )

    columns = ",\n".join(f"{expr} AS {col}" for col, expr in _final_exprs(source, date, entry).items())
    run(
        con,
        f"""CREATE TABLE staged AS
            SELECT {columns}
            FROM categorised p
            JOIN cities c ON c.code = p.city_code
            JOIN raw_files f ON f.file = parse_filename(p.raw_file)
            WHERE p.status = 'mapped' AND p.name IS NOT NULL""",
    )
    target = staged_file(out, date, source)
    target.parent.mkdir(parents=True, exist_ok=True)
    run(
        con,
        f"COPY (SELECT * FROM staged ORDER BY city_code, source_id) TO {sql_str(target.as_posix())} "
        "(FORMAT parquet, COMPRESSION zstd)",
    )

    stats = _stats(con, source, date, meta, extracted)
    write_json(stage_stats_file(out, date, source), stats)
    con.close()
    log.info(
        "%s: %s raw rows, %s staged, unmapped share %.1f%%",
        source,
        f"{stats['raw_rows']:,}",
        f"{stats['staged_rows']:,}",
        100 * stats["unmapped_share"],
    )
    return stats


def _final_exprs(source: str, date: str, entry: SourceEntry) -> dict[str, str]:
    english = (
        "list_filter(p.names_by_lang, lambda x: x.\"language\" = 'en' OR starts_with(x.\"language\", 'en-'))"
    )
    local = 'list_filter(p.names_by_lang, lambda x: list_contains(c.languages, x."language"))'
    exprs = {
        "source": sql_str(source),
        "source_id": "p.source_id",
        "name": "p.name",
        "name_local": f"coalesce(normalize_name({local}[1].value), CASE WHEN NOT is_latin(p.name) THEN p.name END)",
        "name_en": f"coalesce(normalize_name({english}[1].value), CASE WHEN is_latin(p.name) THEN p.name END)",
        "category_source": "p.category_primary",
        "category": "p.category",
        "lat": "round(p.lat, 7)",
        "lon": "round(p.lon, 7)",
        "city_code": "p.city_code",
        "address": "normalize_name(p.address)",
        "website": "nullif(trim(p.website), '')",
        "phone": "nullif(trim(p.phone), '')",
        "opening_hours": "p.opening_hours",
        "wikidata_qid": "p.wikidata_qid",
        "signals": "p.signals",
        "licence": f"coalesce(p.licence, {sql_str(entry.licence)})",
        "fetched_at": "f.fetched_at",
        "raw_ref": f"{sql_str(f'raw/{source}/{date}/')} || parse_filename(p.raw_file)",
    }
    assert list(exprs) == list(STAGED_COLUMNS)
    return {col: f"CAST({expr} AS {STAGED_COLUMNS[col]})" for col, expr in exprs.items()}


def _stats(
    con: duckdb.DuckDBPyConnection, source: str, date: str, meta: dict[str, Any], extracted: list[str]
) -> dict[str, Any]:
    raw_rows = scalar(con, "SELECT count(*) FROM pre")
    unique_rows = scalar(con, "SELECT count(*) FROM uniq")
    closed = scalar(con, "SELECT count(*) FROM uniq WHERE closed")
    no_city = scalar(con, "SELECT count(*) FROM assigned WHERE city_code IS NULL")
    country_mismatch = scalar(
        con, "SELECT count(*) FROM assigned WHERE city_code IS NOT NULL AND NOT country_ok"
    )
    other_city = scalar(
        con,
        "SELECT count(*) FROM assigned WHERE country_ok AND city_code NOT IN (SELECT unnest(?))",
        [extracted],
    )
    located = scalar(con, "SELECT count(*) FROM located")
    no_name = scalar(con, "SELECT count(*) FROM categorised WHERE name IS NULL")
    by_status = dict(run(con, "SELECT status, count(*) FROM categorised GROUP BY status"))
    staged = scalar(con, "SELECT count(*) FROM staged")
    per_city = {
        code: {"raw_rows": meta["files"].get(f"{code}.parquet", {}).get("rows", 0), "staged_rows": 0}
        for code in extracted
    }
    for code, n in run(con, "SELECT city_code, count(*) FROM staged GROUP BY city_code"):
        per_city[code]["staged_rows"] = n
    unmapped_top = [
        {"category_source": cat, "rows": n}
        for cat, n in run(
            con,
            """SELECT coalesce(category_primary, '(none)'), count(*) n FROM categorised
               WHERE status = 'unmapped' GROUP BY 1 ORDER BY n DESC, 1 LIMIT 25""",
        )
    ]
    by_category = dict(run(con, "SELECT category, count(*) FROM staged GROUP BY 1 ORDER BY 1"))
    categorised = located or 1
    return {
        "source": source,
        "run_date": date,
        "version": meta.get("version"),
        "licence": meta.get("licence"),
        "fetched_at": meta.get("fetched_at"),
        "cities": extracted,
        "raw_rows": raw_rows,
        "unique_rows": unique_rows,
        "duplicate_rows": raw_rows - unique_rows,
        "closed": closed,
        "no_city": no_city,
        "country_mismatch": country_mismatch,
        "other_city": other_city,
        "located": located,
        "excluded": by_status.get("excluded", 0),
        "unmapped": by_status.get("unmapped", 0),
        "uncategorised": by_status.get("uncategorised", 0),
        "no_name": no_name,
        "staged_rows": staged,
        "excluded_share": round(by_status.get("excluded", 0) / categorised, 4),
        "unmapped_share": round(by_status.get("unmapped", 0) / categorised, 4),
        "uncategorised_share": round(by_status.get("uncategorised", 0) / categorised, 4),
        "by_category": by_category,
        "unmapped_top": unmapped_top,
        "per_city": per_city,
    }


def stage(
    out: Path,
    date: str,
    *,
    registry: Registry,
    sources: list[str] | None = None,
    ctx: StageContext | None = None,
    allow_disabled: bool = False,
) -> dict[str, dict[str, Any]]:
    ctx = ctx or StageContext.load()
    available = raw_sources(out, date)
    chosen = sources or available
    missing = [s for s in chosen if s not in available]
    if missing:
        raise FileNotFoundError(f"No raw data for {missing} on {date} under {out / 'raw'}")
    if not chosen:
        raise FileNotFoundError(f"No raw data for {date} under {out / 'raw'}; run extract first")
    results = {}
    for source in chosen:
        if source not in PRE_SQL:
            raise ValueError(f"No staging rules for source '{source}'")
        entry = registry.require(source, allow_disabled=allow_disabled)
        results[source] = stage_source(out, date, source, entry, ctx)
    return results
