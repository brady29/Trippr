"""Golden test: stage + check + report on the two-city fixtures, offline, compared with expected output.

After an intended change to staging or the mapping CSVs, regenerate the expected files with
    UPDATE_GOLDEN=1 uv run pytest tests/test_golden.py
and review the diff.
"""

from __future__ import annotations

import csv
import io
import json
import os
import shutil
from pathlib import Path

import duckdb
import pytest

from trippr_data.checks import check
from trippr_data.layout import read_json, report_md, stage_stats_file, staged_file
from trippr_data.report import write_report
from trippr_data.stage import stage

from .conftest import FIXTURE_DATA, FIXTURE_DATE, FIXTURES

EXPECTED = FIXTURES / "expected"
GOLDEN_COLUMNS = (
    "source",
    "source_id",
    "name",
    "name_local",
    "name_en",
    "category_source",
    "category",
    "round(lat, 6) AS lat",
    "round(lon, 6) AS lon",
    "city_code",
    "address",
    "website",
    "phone",
    "licence",
    "strftime(fetched_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ') AS fetched_at",
    "raw_ref",
)
STAT_KEYS = (
    "raw_rows",
    "unique_rows",
    "duplicate_rows",
    "closed",
    "no_city",
    "country_mismatch",
    "other_city",
    "located",
    "excluded",
    "unmapped",
    "no_name",
    "staged_rows",
    "excluded_share",
    "unmapped_share",
    "by_category",
    "per_city",
)


def staged_csv(out: Path) -> str:
    con = duckdb.connect()
    files = ", ".join(f"'{staged_file(out, FIXTURE_DATE, s).as_posix()}'" for s in ("foursquare", "overture"))
    cur = con.execute(
        f"SELECT {', '.join(GOLDEN_COLUMNS)} FROM read_parquet([{files}]) ORDER BY source, source_id"
    )
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow([d[0] for d in cur.description])
    writer.writerows(cur.fetchall())
    return buf.getvalue()


def summary(out: Path, results) -> dict:
    stats = {
        s: {k: read_json(stage_stats_file(out, FIXTURE_DATE, s))[k] for k in STAT_KEYS}
        for s in ("foursquare", "overture")
    }
    return {"stats": stats, "checks": {r.name: r.status for r in results}}


def test_golden_two_cities(tmp_path, registry, ctx):
    out = tmp_path / "out"
    shutil.copytree(FIXTURE_DATA, out)
    stage(out, FIXTURE_DATE, registry=registry, ctx=ctx)
    passed, results = check(out, FIXTURE_DATE, registry=registry, baseline=None)
    write_report(out, FIXTURE_DATE, registry=registry)

    actual_csv = staged_csv(out)
    actual_summary = json.dumps(summary(out, results), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if os.environ.get("UPDATE_GOLDEN"):
        EXPECTED.mkdir(exist_ok=True)
        (EXPECTED / "staged_place.csv").write_text(actual_csv, encoding="utf-8", newline="\n")
        (EXPECTED / "summary.json").write_text(actual_summary, encoding="utf-8", newline="\n")
        pytest.skip("golden files updated")

    assert passed
    assert actual_csv == (EXPECTED / "staged_place.csv").read_text(encoding="utf-8")
    assert actual_summary == (EXPECTED / "summary.json").read_text(encoding="utf-8")
    report = report_md(out, FIXTURE_DATE).read_text(encoding="utf-8")
    assert "Checks: **passed**" in report
    assert "Unmapped share" in report and "TYO Tokyo" in report


def test_report_goes_to_the_github_step_summary(tmp_path, registry, ctx, monkeypatch):
    out = tmp_path / "out"
    shutil.copytree(FIXTURE_DATA, out)
    stage(out, FIXTURE_DATE, registry=registry, ctx=ctx)
    check(out, FIXTURE_DATE, registry=registry, baseline=None)
    summary_file = tmp_path / "summary.md"
    summary_file.write_text("earlier step\n", encoding="utf-8")
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary_file))
    write_report(out, FIXTURE_DATE, registry=registry)
    text = summary_file.read_text(encoding="utf-8")
    assert text.startswith("earlier step\n# Trippr data pipeline run 2026-11-18")
    assert (out / "reports" / "latest.json").is_file()  # passed runs become the next baseline
