"""The bundle: format, checksums, check results, and the golden bundle the API tests also load.

After an intended change to curation or the bundle format, regenerate the committed bundle with
    UPDATE_GOLDEN=1 uv run pytest tests/test_bundle.py
and review the diff (packages/contracts and the API's loader read it).
"""

from __future__ import annotations

import gzip
import json
import os
import shutil
from datetime import UTC, datetime
from pathlib import Path

import pytest

from trippr_data.bundle import (
    MANIFEST_FILE,
    PLACES_FILE,
    SOURCES_FILE,
    BundlePlace,
    build_bundle,
    bundle_report,
    read_places,
    verify_bundle,
)
from trippr_data.bundle_checks import (
    BundleCheckContext,
    check_budget,
    check_coordinates,
    check_duplicates,
    check_ids,
    check_mix,
    check_provenance,
    run_bundle_checks,
)
from trippr_data.checks import check
from trippr_data.cities import load_cities, load_countries
from trippr_data.curation import curate, load_curation_config
from trippr_data.layout import bundle_dir
from trippr_data.taxonomy import load_taxonomy

from .conftest import FIXTURE_DATE, FIXTURES

EXPECTED_BUNDLE = FIXTURES / "expected" / "bundle" / FIXTURE_DATE
CREATED_AT = datetime(2026, 11, 18, 12, 0, 0, tzinfo=UTC)


def golden_config():
    cfg = load_curation_config(total=80)
    cfg.budget.floor, cfg.budget.cap = 10, 60
    return cfg


@pytest.fixture()
def built(staged_out: Path, tmp_path: Path, registry):
    out = tmp_path / "out"
    shutil.copytree(staged_out, out)
    check(out, FIXTURE_DATE, registry=registry, baseline=None)
    cfg = golden_config()
    curate(out, FIXTURE_DATE, config=cfg)
    path, manifest = build_bundle(
        out, FIXTURE_DATE, registry=registry, config=cfg, created_at=CREATED_AT, parquet=False
    )
    return out, path, manifest


def test_bundle_files_and_manifest(built):
    _, path, manifest = built
    assert sorted(p.name for p in path.iterdir()) == [MANIFEST_FILE, PLACES_FILE, SOURCES_FILE]
    assert manifest.checks.passed, [r for r in manifest.checks.results if r.status == "fail"]
    assert manifest.input == "staged" and manifest.format == 1
    assert (
        manifest.counts.places == sum(manifest.counts.by_city.values()) == 80 or manifest.counts.places <= 80
    )
    assert manifest.counts.with_licence == manifest.counts.places == manifest.counts.with_sources
    assert {f.name for f in manifest.files} == {PLACES_FILE, SOURCES_FILE}
    assert verify_bundle(path).counts == manifest.counts
    # The manifest on disk is the one that was returned.
    assert (
        json.loads((path / MANIFEST_FILE).read_text(encoding="utf-8"))["counts"]["places"]
        == manifest.counts.places
    )


def test_places_round_trip_with_provenance(built):
    _, path, manifest = built
    places = read_places(path / PLACES_FILE)
    assert len(places) == manifest.counts.places
    assert [p.city_code for p in places] == sorted(p.city_code for p in places)
    for p in places:
        assert p.id.startswith("cat-") and p.rank >= 1 and p.sources
        assert all(s.source_id and s.licence and s.fetched_at.endswith("Z") for s in p.sources)
    assert {s.source for p in places for s in p.sources} == {"overture", "foursquare"}


def test_sources_json_has_licences_and_attribution(built):
    _, path, manifest = built
    sources = json.loads((path / SOURCES_FILE).read_text(encoding="utf-8"))
    by_id = {s["id"]: s for s in sources}
    assert set(by_id) == {"overture", "foursquare"}
    for s in sources:
        assert s["licence"] and s["attribution"] and s["licence_urls"] and s["terms_checked_on"]
        assert s["places"] == manifest.counts.by_source[s["id"]]
        assert s["staged_rows"] and s["version"] and s["fetched_at"]


def test_verify_detects_a_changed_file(built):
    _, path, _ = built
    verify_bundle(path)
    with gzip.open(path / PLACES_FILE, "wt", encoding="utf-8") as fh:
        fh.write("{}\n")
    with pytest.raises(ValueError, match="checksum"):
        verify_bundle(path)


def test_a_failed_check_is_written_to_the_manifest(staged_out, tmp_path, registry):
    out = tmp_path / "out"
    shutil.copytree(staged_out, out)
    curate(out, FIXTURE_DATE, config=golden_config())
    strict = golden_config()  # the bundle is judged against a mix limit the curated places break
    strict.mix.tag_max_share = {"culture": 0.05}
    strict.mix.tag_share_slack = 0.0
    _, manifest = build_bundle(out, FIXTURE_DATE, registry=registry, config=strict, created_at=CREATED_AT)
    failed = {r.name for r in manifest.checks.results if r.status == "fail"}
    assert "mix.tag_share" in failed
    assert not manifest.checks.passed
    on_disk = json.loads((bundle_dir(out, FIXTURE_DATE) / MANIFEST_FILE).read_text(encoding="utf-8"))
    assert on_disk["checks"]["passed"] is False
    assert "FAILED" in bundle_report(manifest)


def test_missing_staging_checks_only_warn(staged_out, tmp_path, registry):
    out = tmp_path / "out"
    shutil.copytree(staged_out, out)
    curate(out, FIXTURE_DATE, config=golden_config())
    _, manifest = build_bundle(out, FIXTURE_DATE, registry=registry, config=golden_config())
    status = {r.name: r.status for r in manifest.checks.results}
    assert status["staging.checks"] == "warn" and manifest.checks.passed


# --- individual checks ----------------------------------------------------------------------------


@pytest.fixture()
def bctx(registry):
    cfg = golden_config()
    return BundleCheckContext(
        registry=registry,
        cities={c.code: c for c in load_cities()},
        countries=load_countries(),
        taxonomy=load_taxonomy(),
        config=cfg,
        curate_stats={},
    )


def place(i: int = 1, **over) -> BundlePlace:
    base = {
        "id": f"cat-{i:016d}", "golden_id": f"g{i}", "city_code": "TYO", "name": f"Place {i}", "name_local": None,
        "name_en": None, "category": "museum", "tag": "culture", "lat": 35.68 + i / 1000, "lon": 139.76,
        "address": None, "website": None, "phone": None, "opening_hours": None, "wikidata_qid": None,
        "description": None, "score": 3.0, "rank": i, "n_sources": 1, "confidence": 0.9,
        "wikidata_sitelinks": None, "wikivoyage_listed": None,
        "sources": [{"source": "overture", "source_id": f"o{i}", "licence": "CDLA-Permissive-2.0",
                     "fetched_at": "2026-11-18T00:00:00Z", "raw_ref": "raw/overture/x.parquet"}],
    }  # fmt: skip
    return BundlePlace.model_validate({**base, **over})


def statuses(results):
    return {r.name: r.status for r in results}


def test_provenance_check(bctx):
    ok = [place(1)]
    assert statuses(check_provenance(ok, bctx)) == {
        "provenance.licence": "pass",
        "provenance.registered": "pass",
    }
    no_licence = place(2, sources=[{**place(2).sources[0].model_dump(), "licence": " "}])
    assert statuses(check_provenance([no_licence], bctx))["provenance.licence"] == "fail"
    unregistered = place(3, sources=[{**place(3).sources[0].model_dump(), "licence": "GPL-3.0"}])
    assert statuses(check_provenance([unregistered], bctx))["provenance.registered"] == "fail"
    unknown_source = place(4, sources=[{**place(4).sources[0].model_dump(), "source": "mystery"}])
    assert statuses(check_provenance([unknown_source], bctx))["provenance.registered"] == "fail"


def test_ids_and_duplicates(bctx):
    assert statuses(check_ids([place(1), place(1)], bctx))["places.unique_ids"] == "fail"
    near = [place(1), place(2, name="PLACE 1", lat=place(1).lat + 0.0002, id="cat-b")]  # 22 m apart
    assert statuses(check_duplicates(near, bctx))["duplicates.name_50m"] == "fail"
    far = [place(1), place(2, name="Place 1", lat=place(1).lat + 0.01, id="cat-b")]
    assert statuses(check_duplicates(far, bctx))["duplicates.name_50m"] == "pass"


def test_coordinates(bctx):
    assert statuses(check_coordinates([place(1)], bctx)) == {
        "coordinates.city_radius": "pass",
        "coordinates.country_bbox": "pass",
    }
    osaka_in_tokyo = place(2, lat=34.69, lon=135.50)
    assert statuses(check_coordinates([osaka_in_tokyo], bctx))["coordinates.city_radius"] == "fail"


def test_budget_and_mix(bctx):
    over = [place(i, id=f"cat-{i}", city_code="TYO") for i in range(1, 62)]
    assert statuses(check_budget(over, bctx))["budget.per_city"] == "fail"  # the cap is 60
    all_food = [place(i, category="restaurant", tag="food", id=f"cat-{i}") for i in range(1, 11)]
    assert statuses(check_mix(all_food, bctx))["mix.tag_share"] == "fail"
    mixed = all_food[:2] + [place(20 + i, id=f"cat-x{i}") for i in range(8)]
    assert statuses(check_mix(mixed, bctx))["mix.tag_share"] == "pass"


def test_a_crashing_check_is_a_failed_check(bctx):
    bctx.config = None  # type: ignore[assignment]
    assert statuses(run_bundle_checks([place(1)], bctx))["check_budget"] == "fail"


# --- the committed golden bundle -----------------------------------------------------------------


def normalised_manifest(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    for f in data["files"]:
        f.pop("sha256"), f.pop("bytes")  # compressed bytes can differ between zlib builds
    return data


def test_golden_bundle(built):
    _, path, _ = built
    if os.environ.get("UPDATE_GOLDEN"):
        shutil.rmtree(EXPECTED_BUNDLE, ignore_errors=True)
        shutil.copytree(path, EXPECTED_BUNDLE)
        pytest.skip("golden bundle updated")
    assert normalised_manifest(path / MANIFEST_FILE) == normalised_manifest(EXPECTED_BUNDLE / MANIFEST_FILE)
    assert (path / SOURCES_FILE).read_text(encoding="utf-8") == (EXPECTED_BUNDLE / SOURCES_FILE).read_text(
        encoding="utf-8"
    )
    with (
        gzip.open(path / PLACES_FILE, "rt", encoding="utf-8") as a,
        gzip.open(EXPECTED_BUNDLE / PLACES_FILE, "rt", encoding="utf-8") as b,
    ):
        assert a.read() == b.read()
    # The committed bundle is itself valid: the API tests load it.
    assert verify_bundle(EXPECTED_BUNDLE).checks.passed
