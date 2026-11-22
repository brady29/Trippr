"""Data quality checks on the staged Parquet (docs/data-platform-spec.md, Feature 7).

Each check is a plain function taking a DuckDB connection with a `staged` view and a CheckContext,
returning one or more CheckResults. Any "fail" fails the run (the CLI exits non-zero).
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

import duckdb

from .cities import City, Country, load_cities, load_countries
from .duck import connect, rows, run, scalar, sql_str
from .layout import (
    DATE_RE,
    checks_file,
    latest_json,
    read_json,
    reports_dir,
    staged_file,
    staged_sources,
    write_json,
)
from .registry import Registry
from .schema import STAGED_COLUMNS
from .settings import CONFIG_DIR, data_bucket
from .stage import load_cities_table
from .taxonomy import load_taxonomy

log = logging.getLogger(__name__)

Status = Literal["pass", "fail", "warn", "info"]

# Thresholds. ROW_COUNT_TOLERANCE is the spec's ±40% of the last run; cities below
# ROW_COUNT_MIN_ROWS in both runs are only warned about, since small counts swing a lot.
ROW_COUNT_TOLERANCE = 0.40
ROW_COUNT_MIN_ROWS = 100
REQUIRED_FIELDS = (
    "source",
    "source_id",
    "name",
    "category_source",
    "category",
    "lat",
    "lon",
    "city_code",
    "licence",
    "fetched_at",
    "raw_ref",
)
REPORTED_FIELDS = ("name_local", "name_en", "address", "website", "phone")
RADIUS_SLACK_KM = 0.01
COUNTRY_BBOX_MARGIN_DEG = 0.05
MAX_OUTSIDE_COUNTRY_SHARE = 0.001


@dataclass
class CheckResult:
    name: str
    status: Status
    detail: str
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class CheckContext:
    registry: Registry
    cities: dict[str, City]
    countries: dict[str, Country]
    taxonomy: set[str]
    baseline: dict[str, Any] | None = None  # the previous good run's report JSON


def check_schema(con: duckdb.DuckDBPyConnection, ctx: CheckContext) -> list[CheckResult]:
    actual = {r["column_name"]: r["column_type"] for r in rows(con, "DESCRIBE staged")}
    expected = STAGED_COLUMNS
    missing = [c for c in expected if c not in actual]
    extra = [c for c in actual if c not in expected]
    wrong = [c for c in expected if c in actual and _norm_type(actual[c]) != _norm_type(expected[c])]
    if missing or extra or wrong:
        return [CheckResult("schema", "fail", f"missing {missing}, unexpected {extra}, wrong type {wrong}")]
    return [CheckResult("schema", "pass", f"{len(expected)} columns match staged_place")]


def _norm_type(t: str) -> str:
    return t.replace('"', "").replace(" ", "").upper()


def check_row_counts(con: duckdb.DuckDBPyConnection, ctx: CheckContext) -> list[CheckResult]:
    current = counts_by_source_city(con)
    results = []
    empty_sources = [s for s, cities in current.items() if sum(cities.values()) == 0]
    if empty_sources:
        results.append(CheckResult("row_counts.non_empty", "fail", f"no staged rows for {empty_sources}"))
    previous = (ctx.baseline or {}).get("counts")
    if not previous:
        results.append(
            CheckResult("row_counts.vs_previous", "info", "no previous run; counts recorded as the baseline")
        )
        return results
    failures, warnings, compared = [], [], 0
    for source, cities in current.items():
        for city, n in cities.items():
            before = previous.get(source, {}).get(city)
            if before is None:
                continue
            compared += 1
            change = (n - before) / before if before else (0.0 if n == 0 else 1.0)
            if abs(change) <= ROW_COUNT_TOLERANCE:
                continue
            entry = {
                "source": source,
                "city": city,
                "previous": before,
                "current": n,
                "change": round(change, 3),
            }
            (failures if max(n, before) >= ROW_COUNT_MIN_ROWS else warnings).append(entry)
    base = f"{compared} source/city counts compared with the run of {ctx.baseline.get('run_date')}"
    if failures:
        results.append(
            CheckResult(
                "row_counts.vs_previous",
                "fail",
                f"{len(failures)} outside ±{ROW_COUNT_TOLERANCE:.0%}; {base}",
                {"outside": failures},
            )
        )
    else:
        results.append(
            CheckResult("row_counts.vs_previous", "pass", f"all within ±{ROW_COUNT_TOLERANCE:.0%}; {base}")
        )
    if warnings:
        results.append(
            CheckResult(
                "row_counts.small_cities",
                "warn",
                f"{len(warnings)} small counts moved more than ±{ROW_COUNT_TOLERANCE:.0%}",
                {"outside": warnings},
            )
        )
    return results


def check_null_rates(con: duckdb.DuckDBPyConnection, ctx: CheckContext) -> list[CheckResult]:
    exprs = ", ".join(
        f"avg(CASE WHEN {c} IS NULL OR CAST({c} AS VARCHAR) = '' THEN 1 ELSE 0 END) AS {c}"
        for c in (*REQUIRED_FIELDS, *REPORTED_FIELDS)
    )
    by_source = {
        r.pop("source_key"): r
        for r in rows(con, f"SELECT source AS source_key, {exprs} FROM staged GROUP BY source")
    }
    results = []
    bad = {s: {c: v for c, v in r.items() if c in REQUIRED_FIELDS and v} for s, r in by_source.items()}
    bad = {s: v for s, v in bad.items() if v}
    if bad:
        results.append(
            CheckResult("null_rates.required", "fail", f"nulls in required fields: {bad}", {"rates": bad})
        )
    else:
        results.append(
            CheckResult("null_rates.required", "pass", f"no nulls in {', '.join(REQUIRED_FIELDS)}")
        )
    reported = {s: {c: round(r[c], 4) for c in REPORTED_FIELDS} for s, r in by_source.items()}
    detail = "; ".join(
        f"{s}: " + ", ".join(f"{c} {v:.0%}" for c, v in rates.items()) for s, rates in reported.items()
    )
    results.append(CheckResult("null_rates.optional", "info", f"null share: {detail}", {"rates": reported}))
    return results


def check_coordinates(con: duckdb.DuckDBPyConnection, ctx: CheckContext) -> list[CheckResult]:
    run(
        con,
        "CREATE OR REPLACE TABLE countries (iso VARCHAR, min_lon DOUBLE, min_lat DOUBLE, max_lon DOUBLE, max_lat DOUBLE)",
    )
    con.executemany(
        "INSERT INTO countries VALUES (?, ?, ?, ?, ?)",
        [[c.iso, c.min_lon, c.min_lat, c.max_lon, c.max_lat] for c in ctx.countries.values()],
    )
    load_cities_table(con, ctx.cities.values(), ctx.countries)
    total = scalar(con, "SELECT count(*) FROM staged") or 0
    outside_radius = rows(
        con,
        f"""SELECT s.city_code, count(*) n FROM staged s LEFT JOIN cities c ON c.code = s.city_code
            WHERE c.code IS NULL OR hav_km(s.lat, s.lon, c.lat, c.lon) > c.radius_km + {RADIUS_SLACK_KM}
            GROUP BY 1 ORDER BY n DESC""",
    )
    m = COUNTRY_BBOX_MARGIN_DEG
    outside_country = rows(
        con,
        f"""SELECT s.city_code, count(*) n FROM staged s
            JOIN cities c ON c.code = s.city_code LEFT JOIN countries k ON k.iso = c.country
            WHERE k.iso IS NULL OR s.lon NOT BETWEEN k.min_lon - {m} AND k.max_lon + {m}
               OR s.lat NOT BETWEEN k.min_lat - {m} AND k.max_lat + {m}
            GROUP BY 1 ORDER BY n DESC""",
    )
    results = []
    n_radius = sum(r["n"] for r in outside_radius)
    results.append(
        CheckResult(
            "coordinates.city_radius",
            "fail",
            f"{n_radius} rows outside their city's radius",
            {"by_city": outside_radius},
        )
        if n_radius
        else CheckResult("coordinates.city_radius", "pass", f"all {total} rows inside their city's radius")
    )
    n_country = sum(r["n"] for r in outside_country)
    share = n_country / total if total else 0.0
    status: Status = "fail" if share > MAX_OUTSIDE_COUNTRY_SHARE else ("warn" if n_country else "pass")
    results.append(
        CheckResult(
            "coordinates.country_bbox",
            status,
            f"{n_country} rows ({share:.3%}) outside the country's bounding box "
            f"(limit {MAX_OUTSIDE_COUNTRY_SHARE:.1%})",
            {"by_city": outside_country},
        )
    )
    return results


def check_licences(con: duckdb.DuckDBPyConnection, ctx: CheckContext) -> list[CheckResult]:
    missing = scalar(con, "SELECT count(*) FROM staged WHERE licence IS NULL OR trim(licence) = ''")
    used = rows(
        con,
        "SELECT DISTINCT source, unnest(string_split(licence, ' AND ')) AS licence FROM staged WHERE licence IS NOT NULL",
    )
    unregistered = sorted(
        {
            f"{r['source']}:{r['licence']}"
            for r in used
            if r["source"] not in ctx.registry.sources
            or r["licence"] not in ctx.registry.sources[r["source"]].licence_ids()
        }
    )
    results = [
        CheckResult("licence.present", "fail", f"{missing} rows without a licence")
        if missing
        else CheckResult("licence.present", "pass", "every row has a licence")
    ]
    results.append(
        CheckResult("licence.registered", "fail", f"licences not in sources.yaml: {unregistered}")
        if unregistered
        else CheckResult(
            "licence.registered",
            "pass",
            "licences in use: " + ", ".join(sorted({r["licence"] for r in used})),
        )
    )
    return results


def check_duplicates(con: duckdb.DuckDBPyConnection, ctx: CheckContext) -> list[CheckResult]:
    dupes = rows(
        con,
        "SELECT source, source_id, count(*) n FROM staged GROUP BY ALL HAVING count(*) > 1 ORDER BY n DESC LIMIT 10",
    )
    if dupes:
        return [
            CheckResult(
                "duplicates.source_id", "fail", f"{len(dupes)}+ duplicate source ids", {"examples": dupes}
            )
        ]
    return [CheckResult("duplicates.source_id", "pass", "no duplicate source ids")]


def check_categories(con: duckdb.DuckDBPyConnection, ctx: CheckContext) -> list[CheckResult]:
    used = [r[0] for r in run(con, "SELECT DISTINCT category FROM staged")]
    unknown = sorted(c for c in used if c not in ctx.taxonomy)
    if unknown:
        return [CheckResult("categories.in_taxonomy", "fail", f"categories not in taxonomy.csv: {unknown}")]
    return [CheckResult("categories.in_taxonomy", "pass", f"{len(used)} taxonomy categories in use")]


CHECKS: list[Callable[[duckdb.DuckDBPyConnection, CheckContext], list[CheckResult]]] = [
    check_schema,
    check_row_counts,
    check_null_rates,
    check_coordinates,
    check_licences,
    check_duplicates,
    check_categories,
]


def counts_by_source_city(con: duckdb.DuckDBPyConnection) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for source, city, n in run(
        con, "SELECT source, city_code, count(*) FROM staged GROUP BY ALL ORDER BY ALL"
    ):
        out.setdefault(source, {})[city] = n
    return out


def open_staged(paths: list[Path]) -> duckdb.DuckDBPyConnection:
    con = connect()
    files = ", ".join(sql_str(p.as_posix()) for p in paths)
    run(con, f"CREATE VIEW staged AS SELECT * FROM read_parquet([{files}], union_by_name = true)")
    return con


def run_checks(con: duckdb.DuckDBPyConnection, ctx: CheckContext) -> list[CheckResult]:
    results: list[CheckResult] = []
    for check in CHECKS:
        try:
            results.extend(check(con, ctx))
        except Exception as exc:  # a crashing check is a failed check
            log.exception("check %s crashed", check.__name__)
            results.append(CheckResult(check.__name__, "fail", f"check crashed: {exc}"))
    return results


def find_baseline(out: Path, date: str) -> dict[str, Any] | None:
    """The newest passed run before `date`: a local reports/<date>.json, else the bucket's latest.json."""
    local = (
        sorted(p for p in reports_dir(out).glob("*.json") if DATE_RE.match(p.stem) and p.stem < date)
        if reports_dir(out).is_dir()
        else []
    )
    for path in reversed(local):
        data = read_json(path)
        if data.get("passed"):
            return data
    if latest_json(out).is_file():
        data = read_json(latest_json(out))
        if data.get("run_date", "") < date:
            return data
    bucket = data_bucket()
    gcloud = shutil.which("gcloud")
    if bucket and gcloud:
        proc = subprocess.run(
            [gcloud, "storage", "cat", f"gs://{bucket}/reports/latest.json"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            data = json.loads(proc.stdout)
            if data.get("run_date", "") < date:
                return data
        else:
            log.info("no baseline in gs://%s/reports/latest.json", bucket)
    return None


def check(
    out: Path,
    date: str,
    *,
    registry: Registry,
    config_dir: Path = CONFIG_DIR,
    baseline: dict[str, Any] | Literal["auto"] | None = "auto",
) -> tuple[bool, list[CheckResult]]:
    sources = staged_sources(out, date)
    if not sources:
        raise FileNotFoundError(f"No staged data for {date}; run stage first")
    ctx = CheckContext(
        registry=registry,
        cities={c.code: c for c in load_cities(config_dir=config_dir)},
        countries=load_countries(config_dir),
        taxonomy=set(load_taxonomy(config_dir)),
        baseline=find_baseline(out, date) if baseline == "auto" else baseline,
    )
    con = open_staged([staged_file(out, date, s) for s in sources])
    results = run_checks(con, ctx)
    counts = counts_by_source_city(con)
    con.close()
    passed = not any(r.status == "fail" for r in results)
    write_json(
        checks_file(out, date),
        {
            "run_date": date,
            "passed": passed,
            "baseline_run_date": (ctx.baseline or {}).get("run_date"),
            "counts": counts,
            "results": [asdict(r) for r in results],
        },
    )
    for r in results:
        log.log(
            logging.ERROR if r.status == "fail" else logging.INFO, "[%s] %s: %s", r.status, r.name, r.detail
        )
    return passed, results
