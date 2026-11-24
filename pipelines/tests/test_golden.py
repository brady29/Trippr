"""Golden test: stage + check + report on the two-city fixtures, offline, compared with expected output.

Covers all five sources (Overture, Foursquare, OpenStreetMap, Wikidata, Wikivoyage), entity resolution
(links and golden records) and the match checks. After an intended change to staging, matching or the
mapping CSVs, regenerate the expected files with
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
from trippr_data.layout import (
    golden_file,
    links_file,
    match_stats_file,
    read_json,
    report_md,
    stage_stats_file,
    staged_file,
)
from trippr_data.match import match
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
SOURCES = ("foursquare", "osm", "overture", "wikidata", "wikivoyage")
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
    "uncategorised",
    "no_name",
    "staged_rows",
    "excluded_share",
    "unmapped_share",
    "uncategorised_share",
    "by_category",
    "per_city",
)


def staged_csv(out: Path) -> str:
    con = duckdb.connect()
    files = ", ".join(f"'{staged_file(out, FIXTURE_DATE, s).as_posix()}'" for s in SOURCES)
    cur = con.execute(
        f"SELECT {', '.join(GOLDEN_COLUMNS)} FROM read_parquet([{files}]) ORDER BY source, source_id"
    )
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow([d[0] for d in cur.description])
    writer.writerows(cur.fetchall())
    return buf.getvalue()


def summary(out: Path, results) -> dict:
    stats = {s: {k: read_json(stage_stats_file(out, FIXTURE_DATE, s))[k] for k in STAT_KEYS} for s in SOURCES}
    m = read_json(match_stats_file(out, FIXTURE_DATE))
    matched = {
        k: m[k]
        for k in (
            "records_in",
            "clusters_out",
            "multi_source_clusters",
            "multi_record_clusters",
            "links_by_rule",
            "cluster_size_distribution",
            "clusters_by_source_count",
            "refused_by_spread",
        )
    }
    return {"stats": stats, "match": matched, "checks": {r.name: r.status for r in results}}


def matched_csv(out: Path) -> tuple[str, str]:
    """links and golden records as stable CSV text."""
    con = duckdb.connect()
    links = con.execute(
        f"SELECT record_id, city_code, cluster_id, round(score, 3) AS score, rule "
        f"FROM read_parquet('{links_file(out, FIXTURE_DATE).as_posix()}') ORDER BY record_id"
    )
    golden = f"""SELECT golden_id, city_code, name, name_en, name_local, category, round(lat, 6) AS lat,
        round(lon, 6) AS lon, website, opening_hours, wikidata_qid, wikidata_sitelinks, wikivoyage_listed,
        n_sources, n_records, array_to_string(source_names, '+') AS sources,
        array_to_string(licences, '+') AS licences, description_source, description_licence
        FROM read_parquet('{golden_file(out, FIXTURE_DATE).as_posix()}') ORDER BY golden_id"""

    def text(cur) -> str:
        buf = io.StringIO()
        writer = csv.writer(buf, lineterminator="\n")
        writer.writerow([d[0] for d in cur.description])
        writer.writerows(cur.fetchall())
        return buf.getvalue()

    return text(links), text(con.execute(golden))


def test_golden_two_cities(tmp_path, registry, ctx):
    out = tmp_path / "out"
    shutil.copytree(FIXTURE_DATA, out)
    stage(out, FIXTURE_DATE, registry=registry, ctx=ctx)
    match(out, FIXTURE_DATE, registry=registry)
    passed, results = check(out, FIXTURE_DATE, registry=registry, baseline=None)
    write_report(out, FIXTURE_DATE, registry=registry)

    actual_csv = staged_csv(out)
    actual_links, actual_golden = matched_csv(out)
    actual_summary = json.dumps(summary(out, results), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if os.environ.get("UPDATE_GOLDEN"):
        EXPECTED.mkdir(exist_ok=True)
        (EXPECTED / "staged_place.csv").write_text(actual_csv, encoding="utf-8", newline="\n")
        (EXPECTED / "summary.json").write_text(actual_summary, encoding="utf-8", newline="\n")
        (EXPECTED / "links.csv").write_text(actual_links, encoding="utf-8", newline="\n")
        (EXPECTED / "golden.csv").write_text(actual_golden, encoding="utf-8", newline="\n")
        pytest.skip("golden files updated")

    assert passed
    assert actual_csv == (EXPECTED / "staged_place.csv").read_text(encoding="utf-8")
    assert actual_summary == (EXPECTED / "summary.json").read_text(encoding="utf-8")
    assert actual_links == (EXPECTED / "links.csv").read_text(encoding="utf-8")
    assert actual_golden == (EXPECTED / "golden.csv").read_text(encoding="utf-8")
    report = report_md(out, FIXTURE_DATE).read_text(encoding="utf-8")
    assert "Checks: **passed**" in report
    assert "Unmapped share" in report and "TYO Tokyo" in report
    assert "## Entity resolution" in report and "multi-source" in report
    # the fixtures hold places that appear in several sources (the Foursquare rows are Overture rows)
    assert json.loads(actual_summary)["match"]["multi_source_clusters"] > 0


def test_report_goes_to_the_github_step_summary(tmp_path, registry, ctx, monkeypatch):
    out = tmp_path / "out"
    shutil.copytree(FIXTURE_DATA, out)
    stage(out, FIXTURE_DATE, registry=registry, ctx=ctx)
    match(out, FIXTURE_DATE, registry=registry)
    check(out, FIXTURE_DATE, registry=registry, baseline=None)
    summary_file = tmp_path / "summary.md"
    summary_file.write_text("earlier step\n", encoding="utf-8")
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary_file))
    write_report(out, FIXTURE_DATE, registry=registry)
    text = summary_file.read_text(encoding="utf-8")
    assert text.startswith("earlier step\n# Trippr data pipeline run 2026-11-18")
    assert (out / "reports" / "latest.json").is_file()  # passed runs become the next baseline
