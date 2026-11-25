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

import duckdb
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
from trippr_data.bundle_enrichment import (
    ENRICHMENT_FILE,
    ENRICHMENT_PARQUET_FILE,
    BundleEnrichment,
    check_enrichment,
    read_enrichment,
)
from trippr_data.bundle_stay import (
    HOTELS_FILE,
    STAY_UNIT_FILE,
    BundleHotel,
    BundleStayUnit,
    check_stay_bundle,
    read_jsonl_gz,
)
from trippr_data.checks import check
from trippr_data.cities import load_cities, load_countries
from trippr_data.curation import curate, load_curation_config
from trippr_data.layout import bundle_dir
from trippr_data.match import match
from trippr_data.stay import checks as stay_checks
from trippr_data.stay.config import load_stay_config
from trippr_data.stay.layout import curated_stay_dir, stay_staging_dir
from trippr_data.taxonomy import load_taxonomy

from .conftest import FIXTURE_DATE, FIXTURES
from .enrichment_fixture import MODEL, write_fixture_enrichment, write_fixture_eval

EXPECTED_BUNDLE = FIXTURES / "expected" / "bundle" / FIXTURE_DATE
CREATED_AT = datetime(2026, 11, 18, 12, 0, 0, tzinfo=UTC)


def golden_config():
    cfg = load_curation_config(total=80)
    cfg.budget.floor, cfg.budget.cap = 10, 60
    return cfg


def matched_copy(staged_out: Path, tmp_path: Path, registry) -> Path:
    """The staged fixtures with the match stage run on them, as in a real run."""
    out = tmp_path / "out"
    shutil.copytree(staged_out, out)
    match(out, FIXTURE_DATE, registry=registry)
    return out


def with_stay_tables(out: Path, stay_out: Path, registry) -> None:
    """Add the stay stages' output (hotels, Inside Airbnb units, scores) and their check results to `out`."""
    shutil.copytree(curated_stay_dir(stay_out, FIXTURE_DATE), curated_stay_dir(out, FIXTURE_DATE))
    shutil.copytree(stay_staging_dir(stay_out, FIXTURE_DATE), stay_staging_dir(out, FIXTURE_DATE))
    for source in (stay_out / "raw").iterdir():  # the stay checks read the raw files' _meta.json
        if not (out / "raw" / source.name).exists():
            shutil.copytree(source, out / "raw" / source.name)
    passed, _ = stay_checks.check(out, FIXTURE_DATE, registry=registry, baseline=None, verify_raw=False)
    assert passed


@pytest.fixture()
def built(staged_out: Path, stay_out: Path, tmp_path: Path, registry):
    out = matched_copy(staged_out, tmp_path, registry)
    check(out, FIXTURE_DATE, registry=registry, baseline=None)
    cfg = golden_config()
    curate(out, FIXTURE_DATE, config=cfg)
    write_fixture_enrichment(out, FIXTURE_DATE)
    write_fixture_eval(out)
    with_stay_tables(out, stay_out, registry)
    path, manifest = build_bundle(
        out, FIXTURE_DATE, registry=registry, config=cfg, created_at=CREATED_AT, parquet=False
    )
    return out, path, manifest


@pytest.fixture()
def built_without_stay(staged_out: Path, tmp_path: Path, registry):
    out = matched_copy(staged_out, tmp_path, registry)
    cfg = golden_config()
    curate(out, FIXTURE_DATE, config=cfg)
    path, manifest = build_bundle(
        out, FIXTURE_DATE, registry=registry, config=cfg, created_at=CREATED_AT, parquet=False
    )
    return path, manifest


def test_a_bundle_without_stay_data_is_unchanged(built_without_stay):
    path, manifest = built_without_stay
    assert sorted(p.name for p in path.iterdir()) == [MANIFEST_FILE, PLACES_FILE, SOURCES_FILE]
    assert manifest.stay is None and manifest.checks.passed
    assert "stay" not in json.loads((path / MANIFEST_FILE).read_text(encoding="utf-8"))
    assert not any(r.name.startswith("stay.") for r in manifest.checks.results)


def test_bundle_files_and_manifest(built):
    _, path, manifest = built
    assert sorted(p.name for p in path.iterdir()) == [
        ENRICHMENT_FILE,
        HOTELS_FILE,
        MANIFEST_FILE,
        PLACES_FILE,
        SOURCES_FILE,
        STAY_UNIT_FILE,
    ]
    assert manifest.checks.passed, [r for r in manifest.checks.results if r.status == "fail"]
    assert manifest.input == "golden" and manifest.format == 1
    assert (
        manifest.counts.places == sum(manifest.counts.by_city.values()) == 80 or manifest.counts.places <= 80
    )
    assert manifest.counts.with_licence == manifest.counts.places == manifest.counts.with_sources
    assert {f.name for f in manifest.files} == {
        ENRICHMENT_FILE,
        PLACES_FILE,
        SOURCES_FILE,
        STAY_UNIT_FILE,
        HOTELS_FILE,
    }
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
    assert {"overture", "foursquare"} <= {s.source for p in places for s in p.sources}


def test_enrichment_is_bundled_with_provenance(built):
    _, path, manifest = built
    places = read_places(path / PLACES_FILE)
    items = read_enrichment(path / ENRICHMENT_FILE)
    ids = [p.id for p in places]
    assert [i.id for i in items] == [i for i in ids if i in {e.id for e in items}]  # same order as the places
    assert 0 < len(items) < len(places)
    e = manifest.enrichment
    assert e and e.places == len(items) and e.models == [MODEL] and e.source_date == FIXTURE_DATE
    assert e.with_summary == sum(1 for i in items if i.summary) == len(items) - 1
    assert e.enriched_at == "2026-11-18T09:30:00Z"
    assert manifest.evals["enrich"]["model"] == MODEL and manifest.evals["enrich"]["metrics"]["tag_f1"] == 0.8
    assert next(f for f in manifest.files if f.name == ENRICHMENT_FILE).rows == len(items)
    for i in items:
        assert i.ai and i.provenance.model == MODEL and i.provenance.enriched_at.endswith("Z")
        assert i.provenance.summary_ai is bool(i.summary)
        assert bool(i.ai_label) is bool(i.summary)
    # The check that guards the label passed.
    assert {r.name: r.status for r in manifest.checks.results}["enrichment.summary_provenance"] == "pass"


def test_enrichment_parquet_is_narrowed_to_the_bundle(staged_out, tmp_path, registry):
    out = matched_copy(staged_out, tmp_path, registry)
    cfg = golden_config()
    curate(out, FIXTURE_DATE, config=cfg)
    write_fixture_enrichment(out, FIXTURE_DATE)
    path, manifest = build_bundle(out, FIXTURE_DATE, registry=registry, config=cfg, created_at=CREATED_AT)
    assert {f.name for f in manifest.files} >= {ENRICHMENT_FILE, ENRICHMENT_PARQUET_FILE}
    assert verify_bundle(path).enrichment == manifest.enrichment
    con = duckdb.connect()
    n = con.execute(
        f"SELECT count(*) FROM read_parquet('{(path / ENRICHMENT_PARQUET_FILE).as_posix()}')"
    ).fetchone()[0]
    assert n == manifest.enrichment.places


def test_a_bundle_without_enrichment_has_no_enrichment_files(staged_out, tmp_path, registry):
    out = matched_copy(staged_out, tmp_path, registry)
    curate(out, FIXTURE_DATE, config=golden_config())
    path, manifest = build_bundle(out, FIXTURE_DATE, registry=registry, config=golden_config(), parquet=False)
    assert manifest.enrichment is None and "enrich" not in manifest.evals
    assert not (path / ENRICHMENT_FILE).exists()
    assert "enrichment.summary_provenance" not in {r.name for r in manifest.checks.results}


def test_enrichment_from_an_earlier_date_and_eval_scores(staged_out, tmp_path, registry):
    out = matched_copy(staged_out, tmp_path, registry)
    curate(out, FIXTURE_DATE, config=golden_config())
    write_fixture_enrichment(out, FIXTURE_DATE)
    folder = out / "enriched"
    (folder / FIXTURE_DATE).rename(folder / "2026-11-10")  # enriched earlier; the bundle is built later
    report = out / "enrich-eval" / MODEL / "report.json"
    report.parent.mkdir(parents=True)
    report.write_text(
        json.dumps(
            {
                "model": MODEL,
                "judge_model": "claude-haiku-5-5",
                "metrics": {"n": 174, "tag_f1": 0.81, "valid_rate": 1.0, "misses_ignored": 3},
                "targets": {"tag_f1": True},
                "misses": [{"big": "x"}],
            }
        ),
        encoding="utf-8",
    )
    _, manifest = build_bundle(out, FIXTURE_DATE, registry=registry, config=golden_config(), parquet=False)
    assert manifest.enrichment and manifest.enrichment.source_date == "2026-11-10"
    assert manifest.evals["enrich"] == {
        "model": MODEL,
        "judge_model": "claude-haiku-5-5",
        "metrics": {"n": 174, "valid_rate": 1.0, "tag_f1": 0.81},
        "targets": {"tag_f1": True},
    }


def test_stay_tables_in_the_bundle(built):
    _, path, manifest = built
    units = read_jsonl_gz(path / STAY_UNIT_FILE, BundleStayUnit)
    hotels = read_jsonl_gz(path / HOTELS_FILE, BundleHotel)
    stay = manifest.stay
    assert stay is not None
    assert stay.units == {k: sum(1 for u in units if u.unit_kind == k) for k in stay.units}
    assert stay.hotels == len(hotels) > 0 and stay.hotels_in_areas >= stay.hotels
    assert {c.city_code for c in stay.cities} == {"TYO", "SIN"}
    assert all(c.snapshot_date and c.n_listings > 0 for c in stay.cities)
    assert stay.coverage.inside_airbnb_cities == 2 and stay.coverage.trippr_cities >= 100
    assert stay.checks is not None and stay.checks.passed
    assert abs(sum(stay.weights.values()) - 1.0) < 1e-9 and "centrality" in stay.weights
    assert {r.name for r in manifest.checks.results if r.name.startswith("stay.")} >= {
        "stay.units.unique_ids",
        "stay.hotels.provenance",
    }
    assert manifest.checks.passed
    # Provenance travels with every hotel: licence and fetch time per source record.
    assert all(s.licence and s.fetched_at.endswith("Z") for h in hotels for s in h.sources)
    assert {s.source for h in hotels for s in h.sources} >= {"overture"}
    # Aggregates only: the schema has no field that could carry a listing, a host or a name.
    for field in BundleStayUnit.model_fields:
        assert not any(w in field for w in ("listing_id", "host_id", "host_name", "url", "picture"))
    by_id = {(u.unit_kind, u.unit_id): u for u in units}
    shibuya = by_id[("area", "area-tyo-shibuya")]
    assert shibuya.stay_score is not None and shibuya.score_centrality is not None and shibuya.explanation
    assert {h.area_id for h in hotels} <= {u.unit_id for u in units if u.unit_kind == "area"}
    assert all(u.n_listings >= 3 or u.median_price_cad is None for u in units)


def test_hotels_are_capped_per_area(staged_out, stay_out, tmp_path, registry, monkeypatch):
    out = matched_copy(staged_out, tmp_path, registry)
    curate(out, FIXTURE_DATE, config=golden_config())
    with_stay_tables(out, stay_out, registry)
    from trippr_data.bundle_stay import load_hotels

    everything, in_areas = load_hotels(out, FIXTURE_DATE, 1000)
    capped, total = load_hotels(out, FIXTURE_DATE, 1)
    assert total == in_areas == len(everything)
    assert len(capped) == len({h.area_id for h in everything}) < len(everything)
    # The one kept per Area is the best: most sources first.
    for h in capped:
        best = max(e.n_sources for e in everything if e.area_id == h.area_id)
        assert h.n_sources == best


def test_stay_bundle_checks_catch_problems(built, registry):
    _, path, _ = built
    units = read_jsonl_gz(path / STAY_UNIT_FILE, BundleStayUnit)
    hotels = read_jsonl_gz(path / HOTELS_FILE, BundleHotel)
    cfg = load_stay_config()

    def status(u, h):
        return {r.name: r.status for r in check_stay_bundle(u, h, registry=registry, cfg=cfg)}

    assert set(status(units, hotels).values()) == {"pass"}
    assert status(units + units[:1], hotels)["stay.units.unique_ids"] == "fail"
    unknown_area = units[0].model_copy(update={"unit_kind": "area", "unit_id": "area-nowhere"})
    assert status([*units, unknown_area], hotels)["stay.units.areas_known"] == "fail"
    bad_cell = next(u for u in units if u.unit_kind == "h3").model_copy(update={"unit_id": "not-a-cell"})
    assert status([*units, bad_cell], hotels)["stay.units.h3_cells"] == "fail"
    leaky = next(u for u in units if u.unit_kind == "h3").model_copy(
        update={"unit_id": "x", "n_listings": 1, "median_price_cad": 99.0}
    )
    assert status([*units, leaky], hotels)["stay.units.privacy_minimum"] == "fail"
    no_licence = hotels[0].model_copy(
        update={"sources": [hotels[0].sources[0].model_copy(update={"licence": " "})]}
    )
    assert status(units, [no_licence, *hotels[1:]])["stay.hotels.provenance"] == "fail"
    assert (
        status(units, [hotels[0].model_copy(update={"area_id": "area-nowhere"})])["stay.hotels.areas"]
        == "fail"
    )
    assert status(units, [hotels[0], hotels[0]])["stay.hotels.unique_ids"] == "fail"


def test_failed_stay_checks_fail_the_bundle(staged_out, stay_out, tmp_path, registry):
    out = matched_copy(staged_out, tmp_path, registry)
    curate(out, FIXTURE_DATE, config=golden_config())
    with_stay_tables(out, stay_out, registry)
    checks_json = out / "reports" / f"{FIXTURE_DATE}.stay.checks.json"
    data = json.loads(checks_json.read_text(encoding="utf-8"))
    data["passed"] = False
    data["results"][0]["status"] = "fail"
    checks_json.write_text(json.dumps(data), encoding="utf-8")
    _, manifest = build_bundle(out, FIXTURE_DATE, registry=registry, config=golden_config(), parquet=False)
    assert not manifest.checks.passed
    assert {r.name for r in manifest.checks.results if r.status == "fail"} == {"stay.checks"}


def test_parquet_copies_of_the_stay_tables(staged_out, stay_out, tmp_path, registry):
    import duckdb

    out = matched_copy(staged_out, tmp_path, registry)
    curate(out, FIXTURE_DATE, config=golden_config())
    with_stay_tables(out, stay_out, registry)
    path, manifest = build_bundle(out, FIXTURE_DATE, registry=registry, config=golden_config(), parquet=True)
    names = {f.name for f in manifest.files}
    assert {"stay_unit.parquet", "hotels.parquet"} <= names
    assert verify_bundle(path).checks.passed
    con = duckdb.connect()
    n = con.execute(
        f"SELECT count(*) FROM read_parquet('{(path / 'hotels.parquet').as_posix()}')"
    ).fetchone()[0]
    assert n == manifest.stay.hotels


def test_stay_coordinates_in_the_bundle_have_six_decimals(built):
    _, path, _ = built
    for u in read_jsonl_gz(path / STAY_UNIT_FILE, BundleStayUnit):
        assert u.lat == round(u.lat, 6) and u.lon == round(u.lon, 6)


def test_sources_json_has_licences_and_attribution(built):
    _, path, manifest = built
    sources = json.loads((path / SOURCES_FILE).read_text(encoding="utf-8"))
    by_id = {s["id"]: s for s in sources}
    assert {"overture", "foursquare"} <= set(by_id)
    for s in sources:
        assert s["licence"] and s["attribution"] and s["licence_urls"] and s["terms_checked_on"]
        assert s["places"] == manifest.counts.by_source.get(s["id"], 0)
    for s in (by_id["overture"], by_id["foursquare"]):
        assert s["staged_rows"] and s["version"] and s["fetched_at"]


def test_verify_detects_a_changed_file(built):
    _, path, _ = built
    verify_bundle(path)
    with gzip.open(path / PLACES_FILE, "wt", encoding="utf-8") as fh:
        fh.write("{}\n")
    with pytest.raises(ValueError, match="checksum"):
        verify_bundle(path)


def test_a_failed_check_is_written_to_the_manifest(staged_out, tmp_path, registry):
    out = matched_copy(staged_out, tmp_path, registry)
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
    out = matched_copy(staged_out, tmp_path, registry)
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


def enriched(i: int = 1, **over) -> BundleEnrichment:
    base = {
        "id": f"cat-{i:016d}", "tags": ["museum"], "summary": "A museum.", "duration_min": 90, "best_time": "any",
        "indoor": True, "price_level": None, "good_for": [], "display_name": None, "is_generic_name": False,
        "ai": True, "ai_label": "Summary written by AI",
        "provenance": {"summary_ai": True, "model": MODEL, "prompt_version": "enrich-v1",
                       "enriched_at": "2026-11-18T09:30:00Z", "batch_id": "b", "input_sources": []},
    }  # fmt: skip
    prov = {**base["provenance"], **over.pop("provenance", {})}
    return BundleEnrichment.model_validate({**base, **over, "provenance": prov})


def test_enrichment_check_requires_summary_ai_provenance():
    quiet = enriched(2, summary="", ai_label=None, provenance={"summary_ai": False})
    ok = check_enrichment([enriched(1), quiet], 5)
    assert {r.name: r.status for r in ok} == {
        "enrichment.summary_provenance": "pass",
        "enrichment.coverage": "info",
    }
    for bad in (
        enriched(3, provenance={"summary_ai": False}),  # a summary that does not say it is AI
        enriched(4, ai_label=None),  # no label text to show
        enriched(5, ai=False),
        enriched(6, provenance={"model": ""}),
        enriched(7, summary="", ai_label=None, provenance={"summary_ai": True}),  # claims a summary it lacks
    ):
        got = {r.name: r.status for r in check_enrichment([enriched(1), bad], 5)}
        assert got["enrichment.summary_provenance"] == "fail", bad


def test_enrichment_values_are_validated():
    for over in ({"best_time": "dawn"}, {"price_level": "$$$$"}, {"duration_min": 2}, {"surprise": True}):
        with pytest.raises(ValueError):
            enriched(1, **over)


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
    actual, expected = (
        normalised_manifest(path / MANIFEST_FILE),
        normalised_manifest(EXPECTED_BUNDLE / MANIFEST_FILE),
    )
    differing = [
        r["name"]
        for r, e in zip(actual["checks"]["results"], expected["checks"]["results"], strict=False)
        if r != e
    ]
    assert not differing, [
        (r, e)
        for r, e in zip(actual["checks"]["results"], expected["checks"]["results"], strict=False)
        if r != e
    ]
    assert actual == expected
    assert (path / SOURCES_FILE).read_text(encoding="utf-8") == (EXPECTED_BUNDLE / SOURCES_FILE).read_text(
        encoding="utf-8"
    )
    for name in (PLACES_FILE, ENRICHMENT_FILE, STAY_UNIT_FILE, HOTELS_FILE):
        with (
            gzip.open(path / name, "rt", encoding="utf-8") as a,
            gzip.open(EXPECTED_BUNDLE / name, "rt", encoding="utf-8") as b,
        ):
            assert a.read() == b.read(), name + " differs from the golden bundle"

    # The committed bundle is itself valid: the API tests load it.
    assert verify_bundle(EXPECTED_BUNDLE).checks.passed
