"""Stay analytics: aggregate Inside Airbnb listings, hotels and staged places by unit and score each unit.

Units (one table, curated/<date>/stay/stay_unit.parquet):
  city           the Trippr city (listings within its radius): the reference for every comparison
  area           a Trippr Area from seed/areas.json: listings and hotels within its radius of the centre
  neighbourhood  an Inside Airbnb neighbourhood
  h3             an H3 cell (resolution 8) with at least `privacy.min_listings` listings: the map heat layer

Aggregates use only listings with stats_ok (a usable price and a bookable minimum stay) for prices, and
every listing for counts and shares. A unit with fewer than `privacy.min_listings` listings has its
listing statistics left empty, so no single listing can be read from a published aggregate. The scores
come from scoring.py; the Area card text comes from scoring.explain().
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import duckdb

from ..cities import City, load_cities
from ..duck import connect, rows, run, scalar, sql_str
from ..layout import staging_dir, write_json
from ..settings import CONFIG_DIR, SEED_DIR
from .areas import load_areas
from .config import StayConfig, load_stay_config
from .geo import circle_area_km2, h3_area_km2, h3_centre
from .unit_scores import build_summary, score_units, write_units
from .layout import stay_summary_file, stay_table

log = logging.getLogger(__name__)

def _hubs_stations(seed_dir: Path) -> list[dict[str, Any]]:
    with open(seed_dir / "hubs.json", encoding="utf-8") as fh:
        hubs = json.load(fh)["hubs"]
    return [
        {"city": code, "lat": h["lat"], "lon": h["lon"]}
        for h in hubs
        if h.get("kind") == "station"
        for code in h.get("serves") or []
    ]


def _grid_deg(max_radius_km: float) -> float:
    """Grid cell size (degrees) big enough that a 3x3 block of cells covers the largest search radius
    at the highest latitude Trippr has (about 60 degrees, where a degree of longitude is 55 km)."""
    return max(0.005, round(max_radius_km / 50.0, 4))


def build_units(
    con: duckdb.DuckDBPyConnection, cfg: StayConfig, cities: dict[str, City], seed_dir: Path
) -> None:
    run(
        con,
        """CREATE TABLE unit (unit_kind VARCHAR, unit_id VARCHAR, city_code VARCHAR, name VARCHAR, lat DOUBLE,
           lon DOUBLE, radius_km DOUBLE, area_km2 DOUBLE)""",
    )
    covered = [r[0] for r in run(con, "SELECT DISTINCT city_code FROM lst")]
    new: list[list[Any]] = []
    for code in sorted(covered):
        c = cities[code]
        new.append(["city", code, code, c.name, c.lat, c.lon, c.radius_km, circle_area_km2(c.radius_km)])
    areas, _ = load_areas(cfg.areas.default_radius_km, seed_dir)
    for a in areas:
        new.append(["area", a.id, a.city_code, a.name, a.lat, a.lon, a.radius_km, circle_area_km2(a.radius_km)])
    con.executemany("INSERT INTO unit VALUES (?, ?, ?, ?, ?, ?, ?, ?)", new)
    # Inside Airbnb neighbourhoods that have listings; the centre is the median listing location.
    run(
        con,
        """INSERT INTO unit
           SELECT 'neighbourhood', l.city_code || '/' || l.neighbourhood, l.city_code, l.neighbourhood,
                  median(l.lat), median(l.lon), NULL, any_value(n.area_km2)
           FROM lst l LEFT JOIN airbnb_neighbourhood n
             ON n.city_code = l.city_code AND n.neighbourhood = l.neighbourhood
           WHERE l.geo_ok AND l.neighbourhood IS NOT NULL GROUP BY l.city_code, l.neighbourhood""",
    )
    cells = rows(
        con,
        f"""SELECT city_code, h3 FROM lst WHERE geo_ok AND h3 IS NOT NULL
            GROUP BY city_code, h3 HAVING count(*) >= {cfg.privacy.min_listings}""",
    )
    # An H3 cell belongs to the city of most of its listings.
    best: dict[str, str] = {}
    counts: dict[str, int] = {}
    for r in rows(con, "SELECT h3, city_code, count(*) AS n FROM lst WHERE geo_ok AND h3 IS NOT NULL GROUP BY 1, 2"):
        if r["n"] > counts.get(r["h3"], 0):
            best[r["h3"]], counts[r["h3"]] = r["city_code"], r["n"]
    hex_rows = []
    for r in cells:
        if best.get(r["h3"]) != r["city_code"]:
            continue
        lat, lon = h3_centre(r["h3"])
        hex_rows.append(["h3", r["h3"], r["city_code"], r["h3"], lat, lon, None, h3_area_km2(r["h3"])])
    if hex_rows:
        con.executemany("INSERT INTO unit VALUES (?, ?, ?, ?, ?, ?, ?, ?)", hex_rows)


def build_membership(con: duckdb.DuckDBPyConnection) -> None:
    """Which listings count towards which unit. A listing can be in several Areas (they overlap)."""
    run(con, "CREATE TABLE mem (unit_kind VARCHAR, unit_id VARCHAR, city_code VARCHAR, listing_id BIGINT)")
    run(
        con,
        """INSERT INTO mem SELECT 'city', u.unit_id, l.city_code, l.listing_id
           FROM unit u JOIN lst l ON l.city_code = u.city_code AND l.in_radius WHERE u.unit_kind = 'city'""",
    )
    run(
        con,
        """INSERT INTO mem SELECT 'area', u.unit_id, l.city_code, l.listing_id
           FROM unit u JOIN lst l ON l.city_code = u.city_code AND l.geo_ok
             AND l.lat BETWEEN u.lat - u.radius_km / 111.0 AND u.lat + u.radius_km / 111.0
             AND l.lon BETWEEN u.lon - u.radius_km / (111.0 * cos(radians(u.lat))) AND u.lon + u.radius_km / (111.0 * cos(radians(u.lat)))
           WHERE u.unit_kind = 'area' AND hav_km(l.lat, l.lon, u.lat, u.lon) <= u.radius_km""",
    )
    run(
        con,
        """INSERT INTO mem SELECT 'neighbourhood', u.unit_id, l.city_code, l.listing_id
           FROM unit u JOIN lst l ON l.city_code = u.city_code AND l.neighbourhood = u.name
           WHERE u.unit_kind = 'neighbourhood' AND l.geo_ok""",
    )
    run(
        con,
        """INSERT INTO mem SELECT 'h3', u.unit_id, l.city_code, l.listing_id
           FROM unit u JOIN lst l ON l.h3 = u.unit_id AND l.city_code = u.city_code WHERE u.unit_kind = 'h3'""",
    )


def build_metrics(con: duckdb.DuckDBPyConnection, cfg: StayConfig) -> None:
    k = cfg.hosts.multi_listing_min
    run(
        con,
        f"""CREATE TABLE metrics AS
            SELECT m.unit_kind, m.unit_id,
              count(*) AS n_listings,
              count(*) FILTER (WHERE l.stats_ok) AS n_priced,
              count(l.rating) AS n_rated,
              count(*) FILTER (WHERE l.number_of_reviews >= 10) AS n_reviewed10,
              median(l.price_cad) FILTER (WHERE l.stats_ok) AS median_price_cad,
              quantile_cont(l.price_cad, 0.25) FILTER (WHERE l.stats_ok) AS p25_price_cad,
              quantile_cont(l.price_cad, 0.75) FILTER (WHERE l.stats_ok) AS p75_price_cad,
              median(l.price_cad) FILTER (WHERE l.stats_ok AND l.room_type = 'entire_home') AS median_price_entire_cad,
              median(l.price_cad) FILTER (WHERE l.stats_ok AND l.room_type = 'private_room') AS median_price_private_cad,
              median(l.price_per_person_cad) FILTER (WHERE l.stats_ok) AS median_price_pp_cad,
              count(*) FILTER (WHERE l.room_type = 'entire_home')::DOUBLE / count(*) AS entire_home_share,
              count(*) FILTER (WHERE l.room_type = 'private_room')::DOUBLE / count(*) AS private_room_share,
              count(*) FILTER (WHERE l.room_type NOT IN ('entire_home', 'private_room'))::DOUBLE / count(*) AS other_room_share,
              median(l.rating) AS median_rating,
              sum(l.reviews_ltm)::INTEGER AS reviews_ltm,
              avg(l.reviews_ltm) AS reviews_per_listing,
              sum(c.unavailable_days)::DOUBLE / nullif(sum(c.days), 0) AS unavailable_share,
              median(l.availability_365) AS median_availability_365,
              median(l.est_occupancy_days) / 365.0 AS est_occupancy_share,
              avg(l.has_licence::INTEGER) AS licensed_share,
              count(*) FILTER (WHERE l.host_listings >= {k})::DOUBLE / nullif(count(l.host_listings), 0) AS multi_host_share,
              any_value(l.snapshot_date) AS snapshot_date
            FROM mem m
            JOIN lst l ON l.city_code = m.city_code AND l.listing_id = m.listing_id
            LEFT JOIN airbnb_calendar c ON c.city_code = l.city_code AND c.listing_id = l.listing_id
            GROUP BY m.unit_kind, m.unit_id""",
    )
    run(
        con,
        f"""CREATE TABLE host_share AS
            WITH hc AS (
              SELECT m.unit_kind, m.unit_id, l.host_id, count(*) AS n
              FROM mem m JOIN lst l ON l.city_code = m.city_code AND l.listing_id = m.listing_id
              WHERE l.host_id IS NOT NULL GROUP BY ALL),
            ranked AS (
              SELECT *, row_number() OVER (PARTITION BY unit_kind, unit_id ORDER BY n DESC, host_id) AS rn FROM hc)
            SELECT unit_kind, unit_id, sum(n) FILTER (WHERE rn <= {cfg.hosts.top_hosts})::DOUBLE / sum(n) AS top_hosts_share
            FROM ranked GROUP BY 1, 2""",
    )


def build_place_counts(
    con: duckdb.DuckDBPyConnection, cfg: StayConfig, places_files: list[Path]
) -> set[str]:
    """Places and nightlife venues near each unit centre; returns the cities that have staged places."""
    run(con, "CREATE TABLE place_count (unit_kind VARCHAR, unit_id VARCHAR, n_places INTEGER, n_nightlife INTEGER)")
    if not places_files:
        return set()
    files = ", ".join(sql_str(f.as_posix()) for f in places_files)
    grid = _grid_deg(max(cfg.walkability.radius_km, cfg.quiet.radius_km))
    nightlife = ", ".join(sql_str(c) for c in cfg.quiet.nightlife_categories)
    run(
        con,
        f"""CREATE TABLE places AS SELECT city_code, lat, lon, category,
              CAST(floor(lon / {grid}) AS BIGINT) AS gx, CAST(floor(lat / {grid}) AS BIGINT) AS gy
            FROM read_parquet([{files}])""",
    )
    cities_with_places = {r[0] for r in run(con, "SELECT DISTINCT city_code FROM places")}
    run(
        con,
        f"""CREATE TABLE unit_cell AS
            SELECT u.unit_kind, u.unit_id, u.city_code, u.lat, u.lon,
                   CAST(floor(u.lon / {grid}) AS BIGINT) + dx AS gx, CAST(floor(u.lat / {grid}) AS BIGINT) + dy AS gy
            FROM unit u, (SELECT unnest([-1, 0, 1]) AS dx), (SELECT unnest([-1, 0, 1]) AS dy)""",
    )
    run(
        con,
        f"""INSERT INTO place_count
            SELECT uc.unit_kind, uc.unit_id,
              count(*) FILTER (WHERE d <= {cfg.walkability.radius_km})::INTEGER,
              count(*) FILTER (WHERE d <= {cfg.quiet.radius_km} AND p.category IN ({nightlife}))::INTEGER
            FROM (SELECT *, 0.0 AS _ FROM unit_cell) uc
            JOIN places p ON p.city_code = uc.city_code AND p.gx = uc.gx AND p.gy = uc.gy,
            LATERAL (SELECT hav_km(p.lat, p.lon, uc.lat, uc.lon) AS d)
            WHERE d <= {max(cfg.walkability.radius_km, cfg.quiet.radius_km)}
            GROUP BY uc.unit_kind, uc.unit_id""",
    )
    return cities_with_places


def analyse(
    out: Path,
    date: str,
    *,
    places_date: str | None = None,
    places_dir: Path | None = None,
    config_dir: Path = CONFIG_DIR,
    seed_dir: Path = SEED_DIR,
    cfg: StayConfig | None = None,
) -> dict[str, Any]:
    cfg = cfg or load_stay_config(config_dir)
    cities = {c.code: c for c in load_cities(seed_dir, config_dir)}
    con = connect()
    run(con, f"CREATE TABLE lst AS SELECT * FROM read_parquet({sql_str(stay_table(out, date, 'airbnb_listing').as_posix())}) WHERE geo_ok")
    for name in ("airbnb_calendar", "airbnb_neighbourhood"):
        run(con, f"CREATE TABLE {name} AS SELECT * FROM read_parquet({sql_str(stay_table(out, date, name).as_posix())})")
    hotel_path = stay_table(out, date, "hotel")
    run(
        con,
        f"CREATE TABLE hotel AS SELECT * FROM read_parquet({sql_str(hotel_path.as_posix())})"
        if hotel_path.is_file()
        else "CREATE TABLE hotel (hotel_id VARCHAR, lat DOUBLE, lon DOUBLE, city_code VARCHAR)",
    )

    build_units(con, cfg, cities, seed_dir)
    build_membership(con)
    build_metrics(con, cfg)
    places_files = _places_files(out, places_date or date, places_dir)
    cities_with_places = build_place_counts(con, cfg, places_files)
    _hotel_counts(con)
    stations = _hubs_stations(seed_dir)
    run(con, "CREATE TABLE station (city_code VARCHAR, lat DOUBLE, lon DOUBLE)")
    if stations:
        con.executemany("INSERT INTO station VALUES (?, ?, ?)", [[s["city"], s["lat"], s["lon"]] for s in stations])

    run(con, "CREATE TABLE city_ref (code VARCHAR, lat DOUBLE, lon DOUBLE)")
    con.executemany("INSERT INTO city_ref VALUES (?, ?, ?)", [[c.code, c.lat, c.lon] for c in cities.values()])
    base = rows(
        con,
        """SELECT u.*, m.* EXCLUDE (unit_kind, unit_id), h.top_hosts_share, pc.n_places, pc.n_nightlife, hc.n_hotels,
                  hav_km(u.lat, u.lon, cr.lat, cr.lon) AS centre_km,
                  (SELECT min(hav_km(u.lat, u.lon, s.lat, s.lon)) FROM station s WHERE s.city_code = u.city_code) AS station_km
           FROM unit u
           JOIN city_ref cr ON cr.code = u.city_code
           LEFT JOIN metrics m USING (unit_kind, unit_id)
           LEFT JOIN host_share h USING (unit_kind, unit_id)
           LEFT JOIN place_count pc USING (unit_kind, unit_id)
           LEFT JOIN hotel_count hc USING (unit_kind, unit_id)
           ORDER BY u.unit_kind, u.city_code, u.unit_id""",
    )
    units = score_units(con, base, cfg, cities_with_places)
    write_units(con, out, date, units)
    summary = build_summary(date, units, cities, cfg, cities_with_places)
    con.close()
    write_json(stay_summary_file(out, date), summary)
    log.info(
        "stay analytics: %d units (%s)",
        len(units),
        ", ".join(f"{k} {n}" for k, n in summary["units"].items()),
    )
    return summary


def _places_files(out: Path, date: str, places_dir: Path | None) -> list[Path]:
    directory = places_dir or staging_dir(out, date)
    return sorted(p for p in directory.glob("*.parquet") if p.is_file())


def _hotel_counts(con: duckdb.DuckDBPyConnection) -> None:
    run(con, "CREATE TABLE hotel_count (unit_kind VARCHAR, unit_id VARCHAR, n_hotels INTEGER)")
    run(
        con,
        """INSERT INTO hotel_count
           SELECT 'area', u.unit_id, count(h.hotel_id)::INTEGER FROM unit u
           LEFT JOIN hotel h ON h.city_code = u.city_code
             AND h.lat BETWEEN u.lat - u.radius_km / 111.0 AND u.lat + u.radius_km / 111.0
             AND h.lon BETWEEN u.lon - u.radius_km / (111.0 * cos(radians(u.lat))) AND u.lon + u.radius_km / (111.0 * cos(radians(u.lat)))
             AND hav_km(h.lat, h.lon, u.lat, u.lon) <= u.radius_km
           WHERE u.unit_kind = 'area' GROUP BY u.unit_id""",
    )
    run(
        con,
        """INSERT INTO hotel_count
           SELECT 'city', u.unit_id, count(h.hotel_id)::INTEGER FROM unit u
           LEFT JOIN hotel h ON h.city_code = u.city_code AND hav_km(h.lat, h.lon, u.lat, u.lon) <= u.radius_km
           WHERE u.unit_kind = 'city' GROUP BY u.unit_id""",
    )
