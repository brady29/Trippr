"""Turn each unit's aggregates into the published stay_unit rows: privacy minimum, rounding, the documented
score formulas (scoring.py) and the explanation sentence; plus the per-city headline summary."""

from __future__ import annotations

import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any

import duckdb

from ..cities import City
from ..duck import rows, run, sql_str
from .config import StayConfig
from .layout import stay_table
from .scoring import UnitFacts, blend, cheaper_than_share, explain, parts_for

UNIT_KINDS = ("city", "area", "neighbourhood", "h3")

UNIT_COLUMNS: dict[str, str] = {
    "unit_kind": "VARCHAR",
    "unit_id": "VARCHAR",
    "city_code": "VARCHAR",
    "name": "VARCHAR",
    "lat": "DOUBLE",
    "lon": "DOUBLE",
    "radius_km": "DOUBLE",
    "area_km2": "DOUBLE",
    "centre_km": "DOUBLE",
    "station_km": "DOUBLE",
    "snapshot_date": "DATE",
    "n_listings": "INTEGER",
    "n_priced": "INTEGER",
    "n_rated": "INTEGER",
    "n_reviewed10": "INTEGER",
    "median_price_cad": "DOUBLE",
    "p25_price_cad": "DOUBLE",
    "p75_price_cad": "DOUBLE",
    "median_price_entire_cad": "DOUBLE",
    "median_price_private_cad": "DOUBLE",
    "median_price_pp_cad": "DOUBLE",
    "entire_home_share": "DOUBLE",
    "private_room_share": "DOUBLE",
    "other_room_share": "DOUBLE",
    "median_rating": "DOUBLE",
    "reviews_ltm": "INTEGER",
    "reviews_per_listing": "DOUBLE",
    "unavailable_share": "DOUBLE",
    "median_availability_365": "DOUBLE",
    "est_occupancy_share": "DOUBLE",
    "listing_density_km2": "DOUBLE",
    "licensed_share": "DOUBLE",
    "multi_host_share": "DOUBLE",
    "top_hosts_share": "DOUBLE",
    "n_hotels": "INTEGER",
    "n_places": "INTEGER",
    "n_nightlife": "INTEGER",
    "cheaper_than_share": "DOUBLE",
    "score_value": "DOUBLE",
    "score_reviews": "DOUBLE",
    "score_walkability": "DOUBLE",
    "score_quiet": "DOUBLE",
    "stay_score": "DOUBLE",
    "score_parts": "VARCHAR[]",
    "weight_coverage": "DOUBLE",
    "low_sample": "BOOLEAN",
    "explanation": "VARCHAR",
}

# Listing statistics emptied for a unit under the privacy minimum.
LISTING_STAT_COLUMNS = (
    "n_priced",
    "n_rated",
    "n_reviewed10",
    "median_price_cad",
    "p25_price_cad",
    "p75_price_cad",
    "median_price_entire_cad",
    "median_price_private_cad",
    "median_price_pp_cad",
    "entire_home_share",
    "private_room_share",
    "other_room_share",
    "median_rating",
    "reviews_ltm",
    "reviews_per_listing",
    "unavailable_share",
    "median_availability_365",
    "est_occupancy_share",
    "licensed_share",
    "multi_host_share",
    "top_hosts_share",
)
PRICE_COLUMNS = (
    "median_price_cad",
    "p25_price_cad",
    "p75_price_cad",
    "median_price_entire_cad",
    "median_price_private_cad",
    "median_price_pp_cad",
)
SHARE_COLUMNS = (
    "entire_home_share",
    "private_room_share",
    "other_room_share",
    "licensed_share",
    "multi_host_share",
    "top_hosts_share",
    "unavailable_share",
    "est_occupancy_share",
    "cheaper_than_share",
    "reviews_per_listing",
)


def _round(x: float | None, digits: int) -> float | None:
    return None if x is None else round(x, digits)


def score_units(
    con: duckdb.DuckDBPyConnection,
    base: list[dict[str, Any]],
    cfg: StayConfig,
    cities_with_places: set[str],
) -> list[dict[str, Any]]:
    """Apply the privacy minimum, then the documented score formulas, to each unit's aggregates."""
    prices: dict[str, list[float]] = defaultdict(list)
    ratings: dict[str, list[float]] = defaultdict(list)
    for r in rows(con, "SELECT city_code, price_per_person_cad AS price, rating, stats_ok FROM lst WHERE in_radius"):
        if r["stats_ok"] and r["price"] is not None:
            prices[r["city_code"]].append(r["price"])
        if r["rating"] is not None:
            ratings[r["city_code"]].append(r["rating"])
    for series in prices.values():
        series.sort()
    city_rating = {code: statistics.median(v) for code, v in ratings.items() if v}
    city_name = {r[0]: r[1] for r in run(con, "SELECT unit_id, name FROM unit WHERE unit_kind = 'city'")}

    out_rows = []
    for r in base:
        unit = {col: r.get(col) for col in UNIT_COLUMNS}
        if (unit["n_listings"] or 0) < cfg.privacy.min_listings:
            for col in LISTING_STAT_COLUMNS:
                unit[col] = None
        unit["n_listings"] = unit["n_listings"] or 0
        unit["n_priced"] = unit["n_priced"] or 0
        unit["n_rated"] = unit["n_rated"] or 0
        unit["low_sample"] = unit["n_priced"] < cfg.min_priced_listings
        if unit["area_km2"] and unit["n_listings"]:
            unit["listing_density_km2"] = round(unit["n_listings"] / unit["area_km2"], 2)
        has_places = r["city_code"] in cities_with_places and r["unit_kind"] != "city"
        unit["n_places"] = (r.get("n_places") or 0) if has_places else None
        unit["n_nightlife"] = (r.get("n_nightlife") or 0) if has_places else None
        unit["n_hotels"] = r.get("n_hotels") if r["unit_kind"] in ("area", "city") else None
        code = r["city_code"]
        if r["unit_kind"] != "city":
            parts = parts_for(
                price_pp=unit["median_price_pp_cad"],
                city_prices_sorted=prices.get(code, []),
                n_priced=unit["n_priced"],
                rating=unit["median_rating"],
                n_rated=unit["n_rated"],
                city_rating=city_rating.get(code),
                n_places=unit["n_places"],
                n_nightlife=unit["n_nightlife"],
                cfg=cfg,
            )
            mix = blend(parts, cfg.weights, cfg.min_weight_coverage)
            unit["cheaper_than_share"] = (
                cheaper_than_share(unit["median_price_pp_cad"], prices.get(code, []))
                if parts["value"] is not None
                else None
            )
            unit.update(
                score_value=_round(parts["value"], 1),
                score_reviews=_round(parts["reviews"], 1),
                score_walkability=_round(parts["walkability"], 1),
                score_quiet=_round(parts["quiet"], 1),
                stay_score=mix.score,
                score_parts=list(mix.used),
                weight_coverage=mix.weight_coverage,
            )
            unit["explanation"] = explain(
                UnitFacts(
                    city_name=city_name.get(code, code),
                    cheaper_share=unit["cheaper_than_share"],
                    median_price_cad=unit["median_price_cad"] if parts["value"] is not None else None,
                    median_price_pp_cad=unit["median_price_pp_cad"],
                    median_rating=unit["median_rating"] if parts["reviews"] is not None else None,
                    n_rated=unit["n_rated"],
                    n_priced=unit["n_priced"],
                    n_places=unit["n_places"],
                    n_nightlife=unit["n_nightlife"],
                    walk_m=round(cfg.walkability.radius_km * 1000),
                    quiet_m=round(cfg.quiet.radius_km * 1000),
                )
            )
        else:
            unit["score_parts"] = []
        for col in PRICE_COLUMNS:
            unit[col] = _round(unit[col], 2)
        for col in SHARE_COLUMNS:
            unit[col] = _round(unit[col], 4)
        for col in ("centre_km", "station_km", "area_km2"):
            unit[col] = _round(unit[col], 3)
        unit["median_rating"] = _round(unit["median_rating"], 3)
        out_rows.append(unit)
    return out_rows


def write_units(con: duckdb.DuckDBPyConnection, out: Path, date: str, units: list[dict[str, Any]]) -> Path:
    cols = ", ".join(f"{name} {typ}" for name, typ in UNIT_COLUMNS.items())
    run(con, f"CREATE TABLE stay_unit ({cols})")
    placeholders = ", ".join("?" for _ in UNIT_COLUMNS)
    con.executemany(
        f"INSERT INTO stay_unit VALUES ({placeholders})", [[u[c] for c in UNIT_COLUMNS] for u in units]
    )
    target = stay_table(out, date, "stay_unit")
    target.parent.mkdir(parents=True, exist_ok=True)
    run(
        con,
        f"COPY (SELECT * FROM stay_unit ORDER BY unit_kind, city_code, unit_id) TO {sql_str(target.as_posix())} "
        "(FORMAT parquet, COMPRESSION zstd)",
    )
    return target


CITY_SUMMARY_FIELDS = (
    "n_listings",
    "n_priced",
    "median_price_cad",
    "median_price_entire_cad",
    "median_price_private_cad",
    "median_price_pp_cad",
    "entire_home_share",
    "private_room_share",
    "median_rating",
    "reviews_ltm",
    "unavailable_share",
    "est_occupancy_share",
    "multi_host_share",
    "top_hosts_share",
    "licensed_share",
    "n_hotels",
)


def build_summary(
    date: str,
    units: list[dict[str, Any]],
    cities: dict[str, City],
    cfg: StayConfig,
    cities_with_places: set[str],
) -> dict[str, Any]:
    """Headline numbers per Inside Airbnb city, coverage of Trippr's cities and each city's best neighbourhoods."""
    city_units = {u["city_code"]: u for u in units if u["unit_kind"] == "city"}
    covered = sorted(city_units)
    stats: dict[str, Any] = {}
    for code in covered:
        city = city_units[code]
        scored = [
            u
            for u in units
            if u["city_code"] == code
            and u["unit_kind"] == "neighbourhood"
            and u["stay_score"] is not None
            and not u["low_sample"]
        ]
        scored.sort(key=lambda u: (-u["stay_score"], u["unit_id"]))
        count = lambda kind: sum(1 for u in units if u["unit_kind"] == kind and u["city_code"] == code)  # noqa: E731
        stats[code] = {
            "name": cities[code].name,
            "snapshot_date": str(city["snapshot_date"]) if city["snapshot_date"] else None,
            **{k: city[k] for k in CITY_SUMMARY_FIELDS},
            "areas": count("area"),
            "neighbourhoods": count("neighbourhood"),
            "h3_cells": count("h3"),
            "top_neighbourhoods": [
                {"name": u["name"], "stay_score": u["stay_score"], "median_price_cad": u["median_price_cad"]}
                for u in scored[:5]
            ],
        }
    return {
        "run_date": date,
        "units": {k: sum(1 for u in units if u["unit_kind"] == k) for k in UNIT_KINDS},
        "scored_units": sum(1 for u in units if u["stay_score"] is not None),
        "coverage": {
            "trippr_cities": len(cities),
            "inside_airbnb_cities": covered,
            "no_inside_airbnb": len(cities) - len(covered),
            "cities_with_staged_places": len(cities_with_places),
        },
        "weights": cfg.weights.model_dump(),
        "cities": stats,
    }
