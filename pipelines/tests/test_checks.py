from pathlib import Path

import pytest

from trippr_data.checks import (
    CheckContext,
    check,
    check_coordinates,
    check_duplicates,
    check_licences,
    check_null_rates,
    check_row_counts,
    check_schema,
    open_staged,
)
from trippr_data.cities import load_cities, load_countries
from trippr_data.duck import run
from trippr_data.layout import staged_file
from trippr_data.taxonomy import load_taxonomy

from .conftest import FIXTURE_DATE


@pytest.fixture()
def cctx(registry):
    return CheckContext(
        registry=registry,
        cities={c.code: c for c in load_cities()},
        countries=load_countries(),
        taxonomy=set(load_taxonomy()),
    )


@pytest.fixture()
def con(staged_out: Path):
    """A writable copy of the staged fixture rows, so each test can break something."""
    con = open_staged([staged_file(staged_out, FIXTURE_DATE, s) for s in ("overture", "foursquare")])
    run(con, "CREATE TABLE staged_copy AS SELECT * FROM staged")
    run(con, "DROP VIEW staged")
    run(con, "ALTER TABLE staged_copy RENAME TO staged")
    return con


def statuses(results):
    return {r.name: r.status for r in results}


def test_all_checks_pass_on_the_fixtures(staged_out, registry):
    passed, results = check(staged_out, FIXTURE_DATE, registry=registry, baseline=None)
    assert passed, [r for r in results if r.status == "fail"]
    assert statuses(results)["row_counts.vs_previous"] == "info"  # first run just records


def test_schema_check_catches_a_missing_column(con, cctx):
    run(con, "ALTER TABLE staged DROP COLUMN website")
    assert statuses(check_schema(con, cctx))["schema"] == "fail"


def test_null_rates(con, cctx):
    assert statuses(check_null_rates(con, cctx))["null_rates.required"] == "pass"
    run(con, "UPDATE staged SET name = NULL WHERE source_id = (SELECT min(source_id) FROM staged)")
    assert statuses(check_null_rates(con, cctx))["null_rates.required"] == "fail"


def test_coordinates_outside_the_radius_fail(con, cctx):
    assert statuses(check_coordinates(con, cctx))["coordinates.city_radius"] == "pass"
    run(con, "UPDATE staged SET lat = lat + 1 WHERE source_id = (SELECT min(source_id) FROM staged)")
    result = statuses(check_coordinates(con, cctx))
    assert result["coordinates.city_radius"] == "fail"


def test_coordinates_outside_the_country_fail(con, cctx):
    # Move a few rows to Beijing: outside the Japanese bounding box
    run(
        con,
        "UPDATE staged SET lat = 39.9042, lon = 116.4074 WHERE source_id IN (SELECT source_id FROM staged LIMIT 5)",
    )
    assert statuses(check_coordinates(con, cctx))["coordinates.country_bbox"] == "fail"


def test_licence_checks(con, cctx):
    assert set(statuses(check_licences(con, cctx)).values()) == {"pass"}
    run(con, "UPDATE staged SET licence = 'ODbL-1.0' WHERE source_id = (SELECT min(source_id) FROM staged)")
    assert statuses(check_licences(con, cctx))["licence.registered"] == "fail"
    run(con, "UPDATE staged SET licence = NULL WHERE source_id = (SELECT max(source_id) FROM staged)")
    assert statuses(check_licences(con, cctx))["licence.present"] == "fail"


def test_duplicate_source_ids_fail(con, cctx):
    assert statuses(check_duplicates(con, cctx))["duplicates.source_id"] == "pass"
    run(con, "INSERT INTO staged SELECT * FROM staged LIMIT 1")
    assert statuses(check_duplicates(con, cctx))["duplicates.source_id"] == "fail"


def baseline_from(con, factor: float, min_rows: int = 0) -> dict:
    counts: dict = {}
    for source, city, n in run(con, "SELECT source, city_code, count(*) FROM staged GROUP BY ALL"):
        counts.setdefault(source, {})[city] = max(int(n * factor), min_rows)
    return {"run_date": "2026-10-01", "counts": counts}


def test_row_counts_within_tolerance_pass(con, cctx):
    cctx.baseline = baseline_from(con, 1.3)  # current is ~23% below the previous run
    assert statuses(check_row_counts(con, cctx))["row_counts.vs_previous"] == "pass"


def test_row_counts_large_drop_fails(con, cctx):
    cctx.baseline = baseline_from(con, 1.0, min_rows=1000)  # previous run had 1000+ per city
    assert statuses(check_row_counts(con, cctx))["row_counts.vs_previous"] == "fail"


def test_row_counts_small_swings_only_warn(con, cctx, monkeypatch):
    monkeypatch.setattr("trippr_data.checks.ROW_COUNT_MIN_ROWS", 10_000)  # every fixture count is "small"
    cctx.baseline = baseline_from(con, 2.0)
    result = statuses(check_row_counts(con, cctx))
    assert result["row_counts.vs_previous"] == "pass"
    assert result["row_counts.small_cities"] == "warn"
