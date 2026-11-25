"""Data quality checks for the stay tables (docs/data-platform-spec.md, Feature 7). Same contract as
checks.py: each check returns CheckResults, any "fail" fails the run, and results land in
reports/<date>.stay.checks.json for the report. Only the tables that exist are checked."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import date as date_cls
from pathlib import Path
from typing import Any

import duckdb

from ..checks import RADIUS_SLACK_KM, ROW_COUNT_MIN_ROWS, ROW_COUNT_TOLERANCE, CheckResult
from ..cities import City, Country, load_cities, load_countries
from ..duck import connect, rows, run, scalar, sql_str
from ..extract.common import sha256_file
from ..layout import raw_dir, read_json, reports_dir, write_json
from ..registry import Registry
from ..settings import CONFIG_DIR
from .airbnb import LISTING_COLUMNS
from .config import StayConfig, load_stay_config
from .hotels import HOTEL_COLUMNS, KINDS
from .layout import stay_checks_file, stay_stats_file, stay_table
from .unit_scores import LISTING_STAT_COLUMNS, UNIT_COLUMNS

log = logging.getLogger(__name__)

# Thresholds.
MIN_PRICE_SHARE_FAIL = 0.50  # listings with a parseable price, per city
MIN_PRICE_SHARE_WARN = 0.80
MIN_GEO_OK_SHARE = 0.995
MIN_IN_RADIUS_SHARE_WARN = 0.90
MAX_OUTSIDE_COUNTRY_SHARE = 0.005
MEDIAN_PRICE_CAD_RANGE = (15.0, 1000.0)
MAX_OTHER_ROOM_SHARE = 0.01
MIN_NEIGHBOURHOOD_MATCH = 0.99
MIN_CALENDAR_SHARE_WARN = 0.90
REVIEWS_CONSISTENCY_TOLERANCE = 0.10
MAX_SNAPSHOT_AGE_DAYS = 200
MAX_OTHER_KIND_SHARE_WARN = 0.30
DUPLICATE_HOTEL_KM = 0.05


@dataclass
class StayCheckContext:
    out: Path
    date: str
    registry: Registry
    cfg: StayConfig
    cities: dict[str, City]
    countries: dict[str, Country]
    baseline: dict[str, Any] | None = None
    verify_raw: bool = True


def _norm_type(t: str) -> str:
    return t.replace('"', "").replace(" ", "").upper()


def _schema(con: duckdb.DuckDBPyConnection, view: str, expected: dict[str, str], name: str) -> CheckResult:
    actual = {r["column_name"]: r["column_type"] for r in rows(con, f"DESCRIBE {view}")}
    missing = [c for c in expected if c not in actual]
    extra = [c for c in actual if c not in expected]
    wrong = [c for c in expected if c in actual and _norm_type(actual[c]) != _norm_type(expected[c])]
    if missing or extra or wrong:
        return CheckResult(name, "fail", f"missing {missing}, unexpected {extra}, wrong type {wrong}")
    return CheckResult(name, "pass", f"{len(expected)} columns match")


def _nulls(con: duckdb.DuckDBPyConnection, view: str, fields: tuple[str, ...], name: str) -> CheckResult:
    exprs = ", ".join(f"count(*) FILTER (WHERE {f} IS NULL) AS {f}" for f in fields)
    counts = rows(con, f"SELECT {exprs} FROM {view}")[0]
    bad = {k: v for k, v in counts.items() if v}
    if bad:
        return CheckResult(name, "fail", f"nulls in required fields: {bad}", {"nulls": bad})
    return CheckResult(name, "pass", f"no nulls in {', '.join(fields)}")


# --- hotels -----------------------------------------------------------------------------------------


def check_hotels(con: duckdb.DuckDBPyConnection, ctx: StayCheckContext) -> list[CheckResult]:
    results = [
        _schema(con, "hotel", HOTEL_COLUMNS, "stay.hotel.schema"),
        _nulls(
            con,
            "hotel",
            ("hotel_id", "name", "kind", "lat", "lon", "city_code", "sources", "licences"),
            "stay.hotel.required",
        ),
    ]
    dup_ids = scalar(con, "SELECT count(*) - count(DISTINCT hotel_id) FROM hotel")
    results.append(
        CheckResult(
            "stay.hotel.unique_id",
            "fail" if dup_ids else "pass",
            f"{dup_ids} duplicate hotel ids" if dup_ids else "hotel ids are unique",
        )
    )
    run(
        con, "CREATE TABLE city_ref (code VARCHAR, country VARCHAR, lat DOUBLE, lon DOUBLE, radius_km DOUBLE)"
    )
    con.executemany(
        "INSERT INTO city_ref VALUES (?, ?, ?, ?, ?)",
        [[c.code, c.country, c.lat, c.lon, c.radius_km] for c in ctx.cities.values()],
    )
    outside = rows(
        con,
        f"""SELECT h.city_code, count(*) AS n FROM hotel h JOIN city_ref c ON c.code = h.city_code
            WHERE hav_km(h.lat, h.lon, c.lat, c.lon) > c.radius_km + {RADIUS_SLACK_KM} GROUP BY 1""",
    )
    results.append(
        CheckResult(
            "stay.hotel.city_radius",
            "fail" if outside else "pass",
            f"{sum(o['n'] for o in outside)} hotels outside their city's radius"
            if outside
            else "all hotels are inside their city's radius",
            {"outside": outside},
        )
    )
    total = scalar(con, "SELECT count(*) FROM hotel") or 1
    out_country = 0
    for iso, c in ctx.countries.items():
        out_country += scalar(
            con,
            f"""SELECT count(*) FROM hotel h JOIN city_ref c ON c.code = h.city_code
                WHERE c.country = {sql_str(iso)} AND NOT (h.lon BETWEEN {c.min_lon - 0.05} AND {c.max_lon + 0.05}
                  AND h.lat BETWEEN {c.min_lat - 0.05} AND {c.max_lat + 0.05})""",
        )
    share = out_country / total
    results.append(
        CheckResult(
            "stay.hotel.country_bbox",
            "fail" if share > 0.001 else "pass",
            f"{out_country} hotels ({share:.2%}) outside their country's bounding box",
        )
    )
    # Licences: every source record has one, and each is listed for its source in sources.yaml.
    missing = scalar(con, "SELECT count(*) FROM hotel_source WHERE licence IS NULL OR licence = ''")
    unregistered = []
    for r in rows(con, "SELECT source, licence, count(*) AS n FROM hotel_source GROUP BY 1, 2"):
        entry = ctx.registry.sources.get(r["source"])
        used = {p.strip() for p in (r["licence"] or "").split(" AND ") if p.strip()}
        if entry is None or not used <= entry.licence_ids():
            unregistered.append({"source": r["source"], "licence": r["licence"], "rows": r["n"]})
    results.append(
        CheckResult(
            "stay.hotel.licence",
            "fail" if missing or unregistered else "pass",
            f"{missing} records without a licence, {len(unregistered)} licences not in sources.yaml"
            if missing or unregistered
            else "every record has a licence listed in sources.yaml",
            {"unregistered": unregistered},
        )
    )
    near = rows(
        con,
        f"""SELECT a.city_code, a.name, a.hotel_id AS a_id, b.hotel_id AS b_id
            FROM hotel a JOIN hotel b ON a.city_code = b.city_code AND a.hotel_id < b.hotel_id
              AND abs(a.lat - b.lat) < 0.001 AND abs(a.lon - b.lon) < 0.001 AND lower(a.name) = lower(b.name)
            WHERE hav_km(a.lat, a.lon, b.lat, b.lon) <= {DUPLICATE_HOTEL_KM} LIMIT 20""",
    )
    results.append(
        CheckResult(
            "stay.hotel.duplicates",
            "fail" if near else "pass",
            f"{len(near)}+ hotel pairs with the same name within {DUPLICATE_HOTEL_KM * 1000:.0f} m"
            if near
            else "no same-name hotels within 50 m",
            {"examples": near},
        )
    )
    bad_kind = scalar(
        con, f"SELECT count(*) FROM hotel WHERE kind NOT IN ({', '.join(sql_str(k) for k in KINDS)})"
    )
    other_share = (scalar(con, "SELECT count(*) FROM hotel WHERE kind = 'other'") or 0) / total
    status = "fail" if bad_kind else ("warn" if other_share > MAX_OTHER_KIND_SHARE_WARN else "pass")
    results.append(
        CheckResult(
            "stay.hotel.kinds",
            status,
            f"{bad_kind} unknown kinds; {other_share:.1%} of hotels are kind 'other'",
        )
    )
    return results


# --- Inside Airbnb ----------------------------------------------------------------------------------


def check_airbnb(con: duckdb.DuckDBPyConnection, ctx: StayCheckContext) -> list[CheckResult]:
    stats = read_json(stay_stats_file(ctx.out, ctx.date, "airbnb"))
    per_city = stats["per_city"]
    results = [
        _schema(con, "airbnb_listing", LISTING_COLUMNS, "stay.airbnb.schema"),
        _nulls(
            con,
            "airbnb_listing",
            ("city_code", "listing_id", "snapshot_date", "room_type", "currency", "price_status", "stats_ok"),
            "stay.airbnb.required",
        ),
    ]
    dups = sum(c["duplicate_ids"] for c in per_city.values())
    results.append(
        CheckResult(
            "stay.airbnb.unique_ids",
            "fail" if dups else "pass",
            f"{dups} duplicate listing ids" if dups else "listing ids are unique per city",
        )
    )
    low_geo = {
        k: round(v["geo_ok"] / v["listings"], 4)
        for k, v in per_city.items()
        if v["geo_ok"] / v["listings"] < MIN_GEO_OK_SHARE
    }
    results.append(
        CheckResult(
            "stay.airbnb.coordinates",
            "fail" if low_geo else "pass",
            f"too many listings without valid coordinates: {low_geo}"
            if low_geo
            else f"at least {MIN_GEO_OK_SHARE:.1%} of listings have valid coordinates in every city",
        )
    )
    far = {
        k: round(1 - v["in_radius"] / v["listings"], 3)
        for k, v in per_city.items()
        if v["in_radius"] / v["listings"] < MIN_IN_RADIUS_SHARE_WARN
    }
    results.append(
        CheckResult(
            "stay.airbnb.in_city_radius",
            "warn" if far else "pass",
            f"share outside the Trippr city radius: {far}"
            if far
            else f"at least {MIN_IN_RADIUS_SHARE_WARN:.0%} of listings are inside the city radius",
        )
    )
    outside = 0
    total = sum(v["listings"] for v in per_city.values()) or 1
    for iso, c in ctx.countries.items():
        codes = [code for code in per_city if ctx.cities[code].country == iso]
        if not codes:
            continue
        in_list = ", ".join(sql_str(x) for x in codes)
        outside += scalar(
            con,
            f"""SELECT count(*) FROM airbnb_listing WHERE city_code IN ({in_list}) AND geo_ok AND NOT
                (lon BETWEEN {c.min_lon - 0.05} AND {c.max_lon + 0.05} AND lat BETWEEN {c.min_lat - 0.05} AND {c.max_lat + 0.05})""",
        )
    results.append(
        CheckResult(
            "stay.airbnb.country_bbox",
            "fail" if outside / total > MAX_OUTSIDE_COUNTRY_SHARE else "pass",
            f"{outside} listings outside their country's bounding box",
        )
    )
    price_fail = {
        k: round(1 - v["price_missing"] / v["listings"], 3)
        for k, v in per_city.items()
        if 1 - v["price_missing"] / v["listings"] < MIN_PRICE_SHARE_FAIL
    }
    price_warn = {
        k: round(1 - v["price_missing"] / v["listings"], 3)
        for k, v in per_city.items()
        if MIN_PRICE_SHARE_FAIL <= 1 - v["price_missing"] / v["listings"] < MIN_PRICE_SHARE_WARN
    }
    results.append(
        CheckResult(
            "stay.airbnb.price_coverage",
            "fail" if price_fail else ("warn" if price_warn else "pass"),
            f"share of listings with a price: below {MIN_PRICE_SHARE_FAIL:.0%}: {price_fail}; below {MIN_PRICE_SHARE_WARN:.0%}: {price_warn}"
            if price_fail or price_warn
            else f"at least {MIN_PRICE_SHARE_WARN:.0%} of listings have a price in every city",
        )
    )
    lo, hi = MEDIAN_PRICE_CAD_RANGE
    implausible = {
        k: v["median_price_cad"]
        for k, v in per_city.items()
        if v["median_price_cad"] is None or not lo <= v["median_price_cad"] <= hi
    }
    results.append(
        CheckResult(
            "stay.airbnb.price_sanity",
            "fail" if implausible else "pass",
            f"city median CAD price outside {lo:.0f}..{hi:.0f}: {implausible}"
            if implausible
            else f"every city's median price is within CAD {lo:.0f}..{hi:.0f} a night",
        )
    )
    other_rooms = {
        k: v["other_room_type"]
        for k, v in per_city.items()
        if v["other_room_type"] / v["listings"] > MAX_OTHER_ROOM_SHARE
    }
    results.append(
        CheckResult(
            "stay.airbnb.room_types",
            "warn" if other_rooms else "pass",
            f"unrecognised room types: {other_rooms}" if other_rooms else "room types are all recognised",
        )
    )
    bad_fx = [
        k
        for k, v in per_city.items()
        if not v.get("cad_per_unit") or v["cad_per_unit"] <= 0 or v["rate_date"] > v["snapshot"]
    ]
    results.append(
        CheckResult(
            "stay.airbnb.fx",
            "fail" if bad_fx else "pass",
            f"missing or invalid exchange rate for {bad_fx}"
            if bad_fx
            else "every city has a Bank of Canada rate on or before its snapshot date",
        )
    )
    run_day = date_cls.fromisoformat(ctx.date)
    old = {
        k: (run_day - date_cls.fromisoformat(v["snapshot"])).days
        for k, v in per_city.items()
        if (run_day - date_cls.fromisoformat(v["snapshot"])).days > MAX_SNAPSHOT_AGE_DAYS
    }
    results.append(
        CheckResult(
            "stay.airbnb.snapshot_age",
            "warn" if old else "pass",
            f"snapshots older than {MAX_SNAPSHOT_AGE_DAYS} days: {old}"
            if old
            else f"all snapshots are within {MAX_SNAPSHOT_AGE_DAYS} days of the run",
        )
    )
    unmatched = {k: n for k, n in stats["neighbourhoods_not_in_list"].items() if n}
    no_nb = {
        k: v["no_neighbourhood"]
        for k, v in per_city.items()
        if v["no_neighbourhood"] / v["listings"] > 1 - MIN_NEIGHBOURHOOD_MATCH
    }
    results.append(
        CheckResult(
            "stay.airbnb.neighbourhoods",
            "warn" if unmatched or no_nb else "pass",
            f"neighbourhood names not in the city's list: {unmatched}; listings without one: {no_nb}"
            if unmatched or no_nb
            else "every listing's neighbourhood is in the city's neighbourhood list",
        )
    )
    thin_cal = {
        k: round(v.get("calendar_listings", 0) / v["listings"], 3)
        for k, v in per_city.items()
        if v.get("calendar_listings", 0) / v["listings"] < MIN_CALENDAR_SHARE_WARN
    }
    results.append(
        CheckResult(
            "stay.airbnb.calendar",
            "warn" if thin_cal else "pass",
            f"share of listings with a calendar below {MIN_CALENDAR_SHARE_WARN:.0%}: {thin_cal}"
            if thin_cal
            else "calendars cover nearly every listing",
        )
    )
    drift = {}
    for k, v in per_city.items():
        a, b = v.get("reviews_ltm") or 0, v.get("reviews_12m_summary") or 0
        if a and abs(b - a) / a > REVIEWS_CONSISTENCY_TOLERANCE:
            drift[k] = {"listings_file": a, "reviews_file": b}
    results.append(
        CheckResult(
            "stay.airbnb.reviews_consistency",
            "warn" if drift else "pass",
            f"reviews summary and listings disagree by more than {REVIEWS_CONSISTENCY_TOLERANCE:.0%}: {drift}"
            if drift
            else "the reviews summary matches reviews_ltm in the listings within 10%",
        )
    )
    entry = ctx.registry.sources.get("insideairbnb")
    meta = read_json(raw_dir(ctx.out, "insideairbnb", ctx.date) / "_meta.json")
    licence_ok = bool(entry and meta.get("licence") == entry.licence and meta.get("attribution"))
    results.append(
        CheckResult(
            "stay.airbnb.licence",
            "pass" if licence_ok else "fail",
            "licence and attribution recorded in _meta.json match sources.yaml"
            if licence_ok
            else "licence or attribution missing from _meta.json or different from sources.yaml",
        )
    )
    if ctx.verify_raw:
        mismatched = []
        directory = raw_dir(ctx.out, "insideairbnb", ctx.date)
        for rel, f in meta["files"].items():
            path = directory / rel
            if not path.is_file() or sha256_file(path) != f["sha256"]:
                mismatched.append(rel)
        results.append(
            CheckResult(
                "stay.airbnb.checksums",
                "fail" if mismatched else "pass",
                f"raw files missing or changed since download: {mismatched}"
                if mismatched
                else f"{len(meta['files'])} raw files match their recorded checksums",
            )
        )
    return results


# --- unit aggregates --------------------------------------------------------------------------------


def check_units(con: duckdb.DuckDBPyConnection, ctx: StayCheckContext) -> list[CheckResult]:
    results = [_schema(con, "stay_unit", UNIT_COLUMNS, "stay.unit.schema")]
    dup = scalar(con, "SELECT count(*) - count(DISTINCT (unit_kind, unit_id)) FROM stay_unit")
    results.append(
        CheckResult(
            "stay.unit.unique_ids",
            "fail" if dup else "pass",
            f"{dup} duplicate units" if dup else "unit ids are unique per kind",
        )
    )
    bad_scores = scalar(
        con,
        """SELECT count(*) FROM stay_unit WHERE
             score_value NOT BETWEEN 0 AND 100 OR score_reviews NOT BETWEEN 0 AND 100
             OR score_centrality NOT BETWEEN 0 AND 100
             OR score_walkability NOT BETWEEN 0 AND 100 OR score_quiet NOT BETWEEN 0 AND 100
             OR stay_score NOT BETWEEN 0 AND 100""",
    )
    results.append(
        CheckResult(
            "stay.unit.scores_in_range",
            "fail" if bad_scores else "pass",
            f"{bad_scores} units with a score outside 0..100"
            if bad_scores
            else "all scores are within 0..100",
        )
    )
    share_cols = (
        "entire_home_share",
        "private_room_share",
        "other_room_share",
        "multi_host_share",
        "top_hosts_share",
        "licensed_share",
        "unavailable_share",
        "cheaper_than_share",
    )
    bad_shares = scalar(
        con,
        f"SELECT count(*) FROM stay_unit WHERE {' OR '.join(f'{c} NOT BETWEEN 0 AND 1' for c in share_cols)}",
    )
    results.append(
        CheckResult(
            "stay.unit.shares_in_range",
            "fail" if bad_shares else "pass",
            f"{bad_shares} units with a share outside 0..1" if bad_shares else "all shares are within 0..1",
        )
    )
    present = " OR ".join(
        f"{c} IS NOT NULL" for c in LISTING_STAT_COLUMNS if c not in ("n_priced", "n_rated")
    )
    leaks = scalar(
        con,
        f"SELECT count(*) FROM stay_unit WHERE n_listings < {ctx.cfg.privacy.min_listings} AND ({present})",
    )
    small_cells = scalar(
        con,
        f"SELECT count(*) FROM stay_unit WHERE unit_kind = 'h3' AND n_listings < {ctx.cfg.privacy.min_listings}",
    )
    results.append(
        CheckResult(
            "stay.unit.privacy",
            "fail" if leaks or small_cells else "pass",
            f"{leaks} units under the minimum show listing statistics, {small_cells} thin H3 cells published"
            if leaks or small_cells
            else f"no unit under {ctx.cfg.privacy.min_listings} listings shows listing statistics",
        )
    )
    unexplained = scalar(
        con,
        "SELECT count(*) FROM stay_unit WHERE stay_score IS NOT NULL AND (explanation IS NULL OR len(score_parts) = 0)",
    )
    thin = scalar(
        con,
        f"SELECT count(*) FROM stay_unit WHERE stay_score IS NOT NULL AND weight_coverage < {ctx.cfg.min_weight_coverage}",
    )
    results.append(
        CheckResult(
            "stay.unit.explained",
            "fail" if unexplained or thin else "pass",
            f"{unexplained} scored units without parts or explanation, {thin} below the weight coverage floor"
            if unexplained or thin
            else "every scored unit lists its parts and an explanation",
        )
    )
    cover = rows(
        con,
        "SELECT count(*) FILTER (WHERE stay_score IS NOT NULL) AS s, count(*) AS t FROM stay_unit WHERE unit_kind <> 'city'",
    )[0]
    scored, total = cover["s"], cover["t"]
    results.append(
        CheckResult(
            "stay.unit.coverage",
            "info",
            f"{scored} of {total} units have a stay score",
            {"scored": scored, "units": total},
        )
    )
    return results


# --- orchestration ----------------------------------------------------------------------------------


def counts(con: duckdb.DuckDBPyConnection, tables: set[str]) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    if "hotel" in tables:
        out["hotel"] = dict(run(con, "SELECT city_code, count(*) FROM hotel GROUP BY 1 ORDER BY 1"))
    if "airbnb_listing" in tables:
        out["airbnb_listing"] = dict(
            run(con, "SELECT city_code, count(*) FROM airbnb_listing GROUP BY 1 ORDER BY 1")
        )
    return out


def check_counts(current: dict[str, dict[str, int]], baseline: dict[str, Any] | None) -> list[CheckResult]:
    previous = (baseline or {}).get("counts")
    if not previous:
        return [
            CheckResult(
                "stay.counts.vs_previous", "info", "no previous stay run; counts recorded as the baseline"
            )
        ]
    failures, warnings, compared = [], [], 0
    for table, cities in current.items():
        for city, n in cities.items():
            before = previous.get(table, {}).get(city)
            if before is None:
                continue
            compared += 1
            change = (n - before) / before if before else (0.0 if n == 0 else 1.0)
            if abs(change) <= ROW_COUNT_TOLERANCE:
                continue
            entry = {
                "table": table,
                "city": city,
                "previous": before,
                "current": n,
                "change": round(change, 3),
            }
            (failures if max(n, before) >= ROW_COUNT_MIN_ROWS else warnings).append(entry)
    base = f"{compared} counts compared with the stay run of {baseline.get('run_date')}"
    out = [
        CheckResult(
            "stay.counts.vs_previous",
            "fail" if failures else "pass",
            f"{len(failures)} outside ±{ROW_COUNT_TOLERANCE:.0%}; {base}"
            if failures
            else f"all within ±{ROW_COUNT_TOLERANCE:.0%}; {base}",
            {"outside": failures},
        )
    ]
    if warnings:
        out.append(
            CheckResult(
                "stay.counts.small_cities",
                "warn",
                f"{len(warnings)} small counts moved more than ±{ROW_COUNT_TOLERANCE:.0%}",
                {"outside": warnings},
            )
        )
    return out


def find_stay_baseline(out: Path, date: str) -> dict[str, Any] | None:
    """The most recent earlier stay checks file that passed."""
    files = sorted(reports_dir(out).glob("*.stay.checks.json"))
    for path in reversed(files):
        if path.name[:10] < date:
            data = read_json(path)
            if data.get("passed"):
                return data
    return None


def check(
    out: Path,
    date: str,
    *,
    registry: Registry,
    config_dir: Path = CONFIG_DIR,
    baseline: dict[str, Any] | str | None = "auto",
    verify_raw: bool = True,
) -> tuple[bool, list[CheckResult]]:
    cfg = load_stay_config(config_dir)
    ctx = StayCheckContext(
        out=out,
        date=date,
        registry=registry,
        cfg=cfg,
        cities={c.code: c for c in load_cities(config_dir=config_dir)},
        countries=load_countries(config_dir),
        baseline=find_stay_baseline(out, date) if baseline == "auto" else baseline,  # type: ignore[arg-type]
        verify_raw=verify_raw,
    )
    con = connect()
    tables = {
        name
        for name in ("hotel", "hotel_source", "airbnb_listing", "stay_unit")
        if stay_table(out, date, name).is_file()
    }
    if not tables:
        raise FileNotFoundError(f"No stay tables for {date} under {out}; run stay-stage first")
    for name in tables:
        run(
            con,
            f"CREATE VIEW {name} AS SELECT * FROM read_parquet({sql_str(stay_table(out, date, name).as_posix())})",
        )
    results: list[CheckResult] = []
    groups: list[tuple[str, Callable[[duckdb.DuckDBPyConnection, StayCheckContext], list[CheckResult]]]] = [
        ("hotel", check_hotels),
        ("airbnb_listing", check_airbnb),
        ("stay_unit", check_units),
    ]
    for table, fn in groups:
        if table in tables:
            results += fn(con, ctx)
    if "airbnb_listing" in tables and "stay_unit" not in tables:
        results.append(
            CheckResult(
                "stay.unit.exists", "fail", "airbnb is staged but stay-analyse has not produced stay_unit"
            )
        )
    current = counts(con, tables)
    results += check_counts(current, ctx.baseline)
    con.close()
    passed = not any(r.status == "fail" for r in results)
    write_json(
        stay_checks_file(out, date),
        {
            "run_date": date,
            "passed": passed,
            "baseline_run_date": (ctx.baseline or {}).get("run_date"),
            "counts": current,
            "results": [asdict(r) for r in results],
        },
    )
    for r in results:
        log.log(
            logging.ERROR if r.status == "fail" else logging.INFO, "[%s] %s: %s", r.status, r.name, r.detail
        )
    return passed, results
