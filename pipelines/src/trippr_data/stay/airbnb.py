"""Stage Inside Airbnb snapshots into clean tables (staging/<date>/stay/):

airbnb_listing          one row per listing: normalised room type, price in local currency and CAD (at the
                        Bank of Canada rate for the snapshot date), price status, location, reviews,
                        availability, host listing count. No names, descriptions, photos or URLs.
airbnb_calendar         per listing: days covered and days unavailable (booked or blocked) in the next year
airbnb_reviews_monthly  per city and month: number of reviews (from the reviews summary)
airbnb_neighbourhood    per city and neighbourhood: group and polygon area in km2

Prices: "$1,338.49" -> 1338.49 local, x the CAD rate of the snapshot date. price_status says whether a price
may be used: missing, below_floor, above_p99 (city outlier) or ok. stats_ok also requires a minimum stay
a traveller can book (config/stay_score.yaml, price.max_min_nights).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import duckdb

from ..cities import City, load_cities
from ..duck import connect, rows, run, scalar, sql_str
from ..extract.boc_fx import load_rates, rate_on
from ..extract.insideairbnb import AirbnbCity, load_city_map
from ..layout import dated_dirs, raw_dir, read_json, write_json
from ..registry import Registry
from ..settings import CONFIG_DIR
from .config import StayConfig, load_stay_config
from .geo import h3_cell, neighbourhood_areas
from .layout import stay_staging_dir, stay_stats_file, stay_table

log = logging.getLogger(__name__)

SOURCE = "insideairbnb"

LISTING_COLUMNS: dict[str, str] = {
    "city_code": "VARCHAR",
    "listing_id": "BIGINT",
    "snapshot_date": "DATE",
    "lat": "DOUBLE",
    "lon": "DOUBLE",
    "geo_ok": "BOOLEAN",
    "in_radius": "BOOLEAN",
    "h3": "VARCHAR",
    "neighbourhood": "VARCHAR",
    "neighbourhood_group": "VARCHAR",
    "room_type": "VARCHAR",
    "property_type": "VARCHAR",
    "accommodates": "INTEGER",
    "bedrooms": "INTEGER",
    "beds": "INTEGER",
    "currency": "VARCHAR",
    "price_local": "DOUBLE",
    "fx_cad_per_unit": "DOUBLE",
    "price_cad": "DOUBLE",
    "price_per_person_cad": "DOUBLE",
    "price_status": "VARCHAR",
    "minimum_nights": "INTEGER",
    "short_stay": "BOOLEAN",
    "stats_ok": "BOOLEAN",
    "availability_30": "INTEGER",
    "availability_90": "INTEGER",
    "availability_365": "INTEGER",
    "est_occupancy_days": "INTEGER",
    "number_of_reviews": "INTEGER",
    "reviews_ltm": "INTEGER",
    "reviews_12m_summary": "INTEGER",
    "rating": "DOUBLE",
    "rating_location": "DOUBLE",
    "rating_value": "DOUBLE",
    "host_id": "BIGINT",
    "host_listings": "INTEGER",
    "has_licence": "BOOLEAN",
}

ROOM_TYPE_SQL = """CASE lower(trim({col}))
    WHEN 'entire home/apt' THEN 'entire_home'
    WHEN 'private room' THEN 'private_room'
    WHEN 'shared room' THEN 'shared_room'
    WHEN 'hotel room' THEN 'hotel_room'
    ELSE 'other' END"""

PRICE_SQL = "try_cast(replace(regexp_replace({col}, '[^0-9.,]', '', 'g'), ',', '') AS DOUBLE)"


def parse_price(text: str | None) -> float | None:
    """The same parse as PRICE_SQL, for tests and one-offs: "$1,338.49" -> 1338.49."""
    if not text:
        return None
    cleaned = "".join(ch for ch in text if ch.isdigit() or ch in ".,").replace(",", "")
    try:
        return float(cleaned)
    except ValueError:
        return None


def _csv(path: Path, extra: str = "") -> str:
    return (
        f"read_csv({sql_str(path.as_posix())}, header = true, all_varchar = true, strict_mode = false{extra})"
    )


def _column_getter(con: duckdb.DuckDBPyConnection, path: Path):
    have = {r["column_name"] for r in rows(con, f"DESCRIBE SELECT * FROM {_csv(path)}")}

    def col(name: str) -> str:
        return f'"{name}"' if name in have else "NULL"

    return col, have


def find_fx_rates(out: Path, date: str) -> tuple[dict[str, dict[str, float]], str]:
    """The newest Bank of Canada response at or before `date`."""
    candidates = [d for d in dated_dirs(out / "raw" / "boc_fx") if d <= date and (out / "raw" / "boc_fx" / d / "rates.json").is_file()]
    if not candidates:
        raise FileNotFoundError(f"No Bank of Canada rates under {out / 'raw' / 'boc_fx'}; run stay-extract")
    return load_rates(out / "raw" / "boc_fx" / candidates[-1] / "rates.json"), candidates[-1]


def _listing_select(
    con: duckdb.DuckDBPyConnection, path: Path, city: City, ab: AirbnbCity, snapshot: str, rate: float, cfg: StayConfig
) -> str:
    col, _ = _column_getter(con, path)
    for required in ("id", "latitude", "longitude", "room_type", "price"):
        if col(required) == "NULL":
            raise ValueError(f"{path.name}: expected column '{required}' is missing; the format has changed")
    return f"""
        SELECT
          '{city.code}' AS city_code,
          try_cast({col('id')} AS BIGINT) AS listing_id,
          DATE '{snapshot}' AS snapshot_date,
          try_cast({col('latitude')} AS DOUBLE) AS lat,
          try_cast({col('longitude')} AS DOUBLE) AS lon,
          nullif(trim({col('neighbourhood_cleansed')}), '') AS neighbourhood,
          nullif(trim({col('neighbourhood_group_cleansed')}), '') AS neighbourhood_group,
          {ROOM_TYPE_SQL.format(col=col('room_type'))} AS room_type,
          nullif(trim({col('property_type')}), '') AS property_type,
          try_cast({col('accommodates')} AS INTEGER) AS accommodates,
          try_cast({col('bedrooms')} AS INTEGER) AS bedrooms,
          try_cast({col('beds')} AS INTEGER) AS beds,
          '{ab.currency}' AS currency,
          {PRICE_SQL.format(col=col('price'))} AS price_local,
          try_cast({col('minimum_nights')} AS INTEGER) AS minimum_nights,
          try_cast({col('availability_30')} AS INTEGER) AS availability_30,
          try_cast({col('availability_90')} AS INTEGER) AS availability_90,
          try_cast({col('availability_365')} AS INTEGER) AS availability_365,
          try_cast({col('estimated_occupancy_l365d')} AS INTEGER) AS est_occupancy_days,
          try_cast({col('number_of_reviews')} AS INTEGER) AS number_of_reviews,
          try_cast({col('number_of_reviews_ltm')} AS INTEGER) AS reviews_ltm,
          try_cast({col('review_scores_rating')} AS DOUBLE) AS rating,
          try_cast({col('review_scores_location')} AS DOUBLE) AS rating_location,
          try_cast({col('review_scores_value')} AS DOUBLE) AS rating_value,
          try_cast({col('host_id')} AS BIGINT) AS host_id,
          try_cast({col('calculated_host_listings_count')} AS INTEGER) AS host_listings,
          coalesce(trim({col('license')}) <> '', false) AS has_licence,
          {rate} AS fx_cad_per_unit
        FROM {_csv(path)}
    """


def stage_airbnb(
    out: Path,
    date: str,
    *,
    registry: Registry,
    cfg: StayConfig | None = None,
    config_dir: Path = CONFIG_DIR,
    cities: list[City] | None = None,
) -> dict[str, Any]:
    registry.require(SOURCE)
    cfg = cfg or load_stay_config(config_dir)
    directory = raw_dir(out, SOURCE, date)
    meta = read_json(directory / "_meta.json")
    mapping = load_city_map(config_dir)
    by_code = {c.code: c for c in (cities or load_cities(config_dir=config_dir))}
    snapshots: dict[str, str] = meta["snapshots"]
    rates, fx_date = find_fx_rates(out, date)

    con = connect()
    res = cfg.h3_resolution
    con.create_function(
        "h3_cell",
        lambda lat, lon: h3_cell(lat, lon, res) if lat is not None and lon is not None else None,
        ["DOUBLE", "DOUBLE"],
        "VARCHAR",
        null_handling="special",
    )
    fx_rows: list[dict[str, Any]] = []
    created = False
    for code, snapshot in sorted(snapshots.items()):
        ab, city = mapping[code], by_code[code]
        found = rate_on(rates, ab.currency, snapshot)
        if found is None:
            raise ValueError(f"No Bank of Canada rate for {ab.currency} on or before {snapshot} (raw/boc_fx/{fx_date})")
        rate, rate_date = found
        fx_rows.append({"city_code": code, "currency": ab.currency, "snapshot": snapshot, "cad_per_unit": rate, "rate_date": rate_date})
        select = _listing_select(con, directory / code / "listings.csv.gz", city, ab, snapshot, rate, cfg)
        run(con, ("INSERT INTO lst_raw " if created else "CREATE TABLE lst_raw AS ") + select)
        created = True
    if not created:
        raise FileNotFoundError(f"No Inside Airbnb listings in {directory}")

    # Per-city price outlier limit: the configured percentile of CAD prices at or above the floor.
    floor = cfg.price.floor_cad
    run(
        con,
        f"""CREATE TABLE price_limit AS
            SELECT city_code, quantile_cont(price_local * fx_cad_per_unit, {cfg.price.outlier_percentile}) AS p_high
            FROM lst_raw WHERE price_local * fx_cad_per_unit >= {floor} GROUP BY 1""",
    )
    run(con, "CREATE TABLE acity (code VARCHAR, lat DOUBLE, lon DOUBLE, radius_km DOUBLE)")
    con.executemany(
        "INSERT INTO acity VALUES (?, ?, ?, ?)", [[c, by_code[c].lat, by_code[c].lon, by_code[c].radius_km] for c in snapshots]
    )
    cols = {
        "city_code": "r.city_code",
        "listing_id": "r.listing_id",
        "snapshot_date": "r.snapshot_date",
        "lat": "r.lat",
        "lon": "r.lon",
        "geo_ok": "(r.lat BETWEEN -90 AND 90 AND r.lon BETWEEN -180 AND 180 AND NOT (r.lat = 0 AND r.lon = 0))",
        "in_radius": "(r.lat BETWEEN -90 AND 90 AND r.lon BETWEEN -180 AND 180 AND hav_km(r.lat, r.lon, c.lat, c.lon) <= c.radius_km)",
        "h3": "CASE WHEN r.lat BETWEEN -90 AND 90 AND r.lon BETWEEN -180 AND 180 THEN h3_cell(r.lat, r.lon) END",
        "neighbourhood": "r.neighbourhood",
        "neighbourhood_group": "r.neighbourhood_group",
        "room_type": "r.room_type",
        "property_type": "r.property_type",
        "accommodates": "r.accommodates",
        "bedrooms": "r.bedrooms",
        "beds": "r.beds",
        "currency": "r.currency",
        "price_local": "r.price_local",
        "fx_cad_per_unit": "r.fx_cad_per_unit",
        "price_cad": "round(r.price_local * r.fx_cad_per_unit, 2)",
        "price_per_person_cad": "round(r.price_local * r.fx_cad_per_unit / greatest(coalesce(r.accommodates, 1), 1), 2)",
        "price_status": f"""CASE WHEN r.price_local IS NULL OR r.price_local <= 0 THEN 'missing'
                              WHEN r.price_local * r.fx_cad_per_unit < {floor} THEN 'below_floor'
                              WHEN r.price_local * r.fx_cad_per_unit > pl.p_high THEN 'above_p99'
                              ELSE 'ok' END""",
        "minimum_nights": "r.minimum_nights",
        "short_stay": f"coalesce(r.minimum_nights <= {cfg.price.max_min_nights}, true)",
        "stats_ok": f"""(CASE WHEN r.price_local IS NULL OR r.price_local <= 0 THEN false
                              WHEN r.price_local * r.fx_cad_per_unit < {floor} THEN false
                              WHEN r.price_local * r.fx_cad_per_unit > pl.p_high THEN false
                              ELSE true END) AND coalesce(r.minimum_nights <= {cfg.price.max_min_nights}, true)""",
        "availability_30": "r.availability_30",
        "availability_90": "r.availability_90",
        "availability_365": "r.availability_365",
        "est_occupancy_days": "r.est_occupancy_days",
        "number_of_reviews": "r.number_of_reviews",
        "reviews_ltm": "r.reviews_ltm",
        "reviews_12m_summary": "rv.n",
        "rating": "r.rating",
        "rating_location": "r.rating_location",
        "rating_value": "r.rating_value",
        "host_id": "r.host_id",
        "host_listings": "r.host_listings",
        "has_licence": "r.has_licence",
    }
    assert list(cols) == list(LISTING_COLUMNS)

    # Reviews summary: reviews per listing in the 12 months up to the snapshot, and per month.
    run(con, "CREATE TABLE rev_12m (city_code VARCHAR, listing_id BIGINT, n INTEGER)")
    run(
        con,
        "CREATE TABLE rev_month (city_code VARCHAR, month DATE, reviews INTEGER, listings INTEGER)",
    )
    for code, snapshot in sorted(snapshots.items()):
        path = directory / code / "reviews.csv"
        if not path.is_file():
            continue
        run(
            con,
            f"""INSERT INTO rev_12m
                SELECT '{code}', try_cast(listing_id AS BIGINT), count(*)::INTEGER
                FROM {_csv(path)}
                WHERE try_cast(date AS DATE) > DATE '{snapshot}' - INTERVAL 365 DAY AND try_cast(date AS DATE) <= DATE '{snapshot}'
                GROUP BY 1, 2""",
        )
        run(
            con,
            f"""INSERT INTO rev_month
                SELECT '{code}', date_trunc('month', try_cast(date AS DATE))::DATE, count(*)::INTEGER,
                       count(DISTINCT listing_id)::INTEGER
                FROM {_csv(path)} WHERE try_cast(date AS DATE) IS NOT NULL GROUP BY 1, 2""",
        )
    run(
        con,
        f"""CREATE TABLE airbnb_listing AS
            SELECT {', '.join(f'CAST({expr} AS {LISTING_COLUMNS[name]}) AS {name}' for name, expr in cols.items())}
            FROM lst_raw r
            JOIN acity c ON c.code = r.city_code
            LEFT JOIN price_limit pl ON pl.city_code = r.city_code
            LEFT JOIN rev_12m rv ON rv.city_code = r.city_code AND rv.listing_id = r.listing_id
            QUALIFY row_number() OVER (PARTITION BY r.city_code, r.listing_id ORDER BY r.snapshot_date) = 1""",
    )

    # Calendar: days covered and days unavailable per listing.
    run(
        con,
        """CREATE TABLE airbnb_calendar (city_code VARCHAR, listing_id BIGINT, days INTEGER, unavailable_days INTEGER,
           unavailable_30 INTEGER, unavailable_90 INTEGER, first_date DATE, last_date DATE)""",
    )
    for code in sorted(snapshots):
        path = directory / code / "calendar.csv.gz"
        if not path.is_file():
            continue
        run(
            con,
            f"""INSERT INTO airbnb_calendar
                WITH cal AS (
                  SELECT try_cast(listing_id AS BIGINT) AS listing_id, try_cast(date AS DATE) AS d,
                         lower(available) IN ('f', 'false') AS blocked
                  FROM {_csv(path)}),
                start AS (SELECT min(d) AS d0 FROM cal)
                SELECT '{code}', listing_id, count(*)::INTEGER, count(*) FILTER (WHERE blocked)::INTEGER,
                       count(*) FILTER (WHERE blocked AND d < d0 + 30)::INTEGER,
                       count(*) FILTER (WHERE blocked AND d < d0 + 90)::INTEGER, min(d), max(d)
                FROM cal, start WHERE d IS NOT NULL AND listing_id IS NOT NULL GROUP BY listing_id""",
        )

    # Neighbourhood polygons -> area.
    run(
        con,
        "CREATE TABLE airbnb_neighbourhood (city_code VARCHAR, neighbourhood VARCHAR, neighbourhood_group VARCHAR, area_km2 DOUBLE)",
    )
    for code in sorted(snapshots):
        geo = directory / code / "neighbourhoods.geojson"
        areas = neighbourhood_areas(geo) if geo.is_file() else {}
        names = rows(con, f"SELECT neighbourhood_group, neighbourhood FROM {_csv(directory / code / 'neighbourhoods.csv')}")
        con.executemany(
            "INSERT INTO airbnb_neighbourhood VALUES (?, ?, ?, ?)",
            [[code, n["neighbourhood"], n["neighbourhood_group"] or None, round(areas[n["neighbourhood"]], 4) if n["neighbourhood"] in areas else None] for n in names],
        )

    paths = {name: stay_table(out, date, name) for name in ("airbnb_listing", "airbnb_calendar", "airbnb_neighbourhood")}
    paths["airbnb_reviews_monthly"] = stay_table(out, date, "airbnb_reviews_monthly")
    stay_staging_dir(out, date).mkdir(parents=True, exist_ok=True)
    order = {
        "airbnb_listing": "city_code, listing_id",
        "airbnb_calendar": "city_code, listing_id",
        "airbnb_neighbourhood": "city_code, neighbourhood",
    }
    for name, target in paths.items():
        source_table = "rev_month" if name == "airbnb_reviews_monthly" else name
        order_by = order.get(name, "city_code, month")
        run(con, f"COPY (SELECT * FROM {source_table} ORDER BY {order_by}) TO {sql_str(target.as_posix())} (FORMAT parquet, COMPRESSION zstd)")

    stats = _stats(con, meta, snapshots, fx_rows, fx_date, cfg)
    stats["run_date"] = date
    con.close()
    write_json(stay_stats_file(out, date, "airbnb"), stats)
    log.info("airbnb: %s listings in %d cities", f"{stats['listings']:,}", len(snapshots))
    return stats


def _stats(
    con: duckdb.DuckDBPyConnection,
    meta: dict[str, Any],
    snapshots: dict[str, str],
    fx_rows: list[dict[str, Any]],
    fx_date: str,
    cfg: StayConfig,
) -> dict[str, Any]:
    per_city = {}
    for r in rows(
        con,
        """SELECT city_code, count(*) AS listings,
                  count(*) FILTER (WHERE geo_ok) AS geo_ok, count(*) FILTER (WHERE in_radius) AS in_radius,
                  count(*) FILTER (WHERE price_status = 'missing') AS price_missing,
                  count(*) FILTER (WHERE price_status = 'below_floor') AS below_floor,
                  count(*) FILTER (WHERE price_status = 'above_p99') AS above_p99,
                  count(*) FILTER (WHERE price_status = 'ok') AS price_ok,
                  count(*) FILTER (WHERE NOT short_stay) AS long_stay,
                  count(*) FILTER (WHERE stats_ok) AS stats_ok,
                  count(*) FILTER (WHERE stats_ok AND in_radius) AS stats_ok_in_radius,
                  count(*) FILTER (WHERE neighbourhood IS NULL) AS no_neighbourhood,
                  count(*) FILTER (WHERE room_type = 'other') AS other_room_type,
                  count(*) - count(DISTINCT listing_id) AS duplicate_ids,
                  count(*) FILTER (WHERE rating IS NOT NULL) AS rated,
                  sum(reviews_ltm) AS reviews_ltm, sum(reviews_12m_summary) AS reviews_12m_summary,
                  round(median(price_cad) FILTER (WHERE stats_ok), 2) AS median_price_cad
           FROM airbnb_listing GROUP BY 1 ORDER BY 1""",
    ):
        code = r.pop("city_code")
        per_city[code] = r
    for f in fx_rows:
        per_city[f["city_code"]].update(
            snapshot=f["snapshot"], currency=f["currency"], cad_per_unit=f["cad_per_unit"], rate_date=f["rate_date"]
        )
    for r in rows(con, "SELECT city_code, count(*) AS calendar_listings, sum(days) AS calendar_days FROM airbnb_calendar GROUP BY 1"):
        per_city[r["city_code"]].update(calendar_listings=r["calendar_listings"], calendar_days=r["calendar_days"])
    for r in rows(con, "SELECT city_code, max(p_high) AS p_high FROM price_limit GROUP BY 1"):
        per_city[r["city_code"]]["p_high_cad"] = round(r["p_high"], 2)
    for r in rows(con, "SELECT city_code, count(*) AS neighbourhoods, count(area_km2) AS with_area FROM airbnb_neighbourhood GROUP BY 1"):
        per_city[r["city_code"]].update(neighbourhoods=r["neighbourhoods"], neighbourhoods_with_area=r["with_area"])
    unknown_nb = rows(
        con,
        """SELECT l.city_code, count(DISTINCT l.neighbourhood) AS n FROM airbnb_listing l
           LEFT JOIN airbnb_neighbourhood n ON n.city_code = l.city_code AND n.neighbourhood = l.neighbourhood
           WHERE l.neighbourhood IS NOT NULL AND n.neighbourhood IS NULL GROUP BY 1""",
    )
    return {
        "source": SOURCE,
        "snapshots": dict(sorted(snapshots.items())),
        "licence": meta.get("licence"),
        "attribution": meta.get("attribution"),
        "fx_raw_date": fx_date,
        "listings": scalar(con, "SELECT count(*) FROM airbnb_listing"),
        "per_city": per_city,
        "neighbourhoods_not_in_list": {r["city_code"]: r["n"] for r in unknown_nb},
        "price_floor_cad": cfg.price.floor_cad,
        "outlier_percentile": cfg.price.outlier_percentile,
        "max_min_nights": cfg.price.max_min_nights,
        "raw_files": {k: {"sha256": v["sha256"], "snapshot": v["snapshot"]} for k, v in meta["files"].items()},
    }
