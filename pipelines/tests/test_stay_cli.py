"""The stay commands are wired into the CLI without disturbing the places pipeline."""

from __future__ import annotations

import shutil

import pytest

from trippr_data import cli
from trippr_data.registry import load_registry
from trippr_data.stage import stage

from .conftest import FIXTURE_DATA, FIXTURE_DATE, STAY_FIXTURES


def test_stay_commands_are_registered():
    parser = cli.build_parser()
    for name in ("stay-extract", "stay-stage", "stay-analyse", "stay-check", "stay-report", "stay"):
        args = parser.parse_args([name, "--date", "2026-11-18"])
        assert args.fn is not None
    args = parser.parse_args(["stay-analyse", "--places", "bundle/places.parquet"])
    assert str(args.places).endswith("places.parquet")


def test_places_extract_ignores_the_stay_sources():
    registry = load_registry()
    names = cli._sources(None, registry)
    assert names and not {"insideairbnb", "osm_lodging", "boc_fx"} & set(names)
    with pytest.raises(SystemExit):
        cli._sources("insideairbnb", registry)  # stay sources have their own command


def test_stage_skips_raw_folders_it_has_no_rules_for(tmp_path, registry, ctx):
    shutil.copytree(FIXTURE_DATA, tmp_path, dirs_exist_ok=True)
    shutil.copytree(STAY_FIXTURES / "raw" / "insideairbnb", tmp_path / "raw" / "insideairbnb")
    shutil.copytree(STAY_FIXTURES / "raw" / "boc_fx", tmp_path / "raw" / "boc_fx")
    results = stage(tmp_path, FIXTURE_DATE, registry=registry, ctx=ctx)
    assert {"overture", "foursquare"} <= set(results)
    assert not {"insideairbnb", "boc_fx"} & set(results)


def test_main_report_gets_a_stay_section_when_the_stay_stages_ran(stay_out, staged_out, registry, tmp_path):
    from trippr_data.checks import check
    from trippr_data.report import build_report

    out = tmp_path / "out"
    shutil.copytree(staged_out, out)
    shutil.copytree(stay_out / "staging" / FIXTURE_DATE / "stay", out / "staging" / FIXTURE_DATE / "stay")
    shutil.copytree(stay_out / "curated", out / "curated")
    check(out, FIXTURE_DATE, registry=registry, baseline=None)
    text, _ = build_report(out, FIXTURE_DATE, registry=registry)
    assert "## Stay analytics" in text and "Inside Airbnb has data for 2 of Trippr's 108 cities" in text
    plain, _ = build_report(staged_out, FIXTURE_DATE, registry=registry)
    assert "Stay analytics" not in plain
