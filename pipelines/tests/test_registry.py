from datetime import date

import pytest

from trippr_data.registry import SourceDisabledError, SourceNotRegisteredError, load_registry


def test_registry_has_both_pr1_sources_with_terms_dates():
    registry = load_registry()
    assert {"overture", "foursquare"} <= set(registry.sources)
    for entry in registry.sources.values():
        assert entry.terms_checked_on >= date(2026, 11, 1)
        assert entry.attribution.strip()
        assert entry.allowed_uses


def test_overture_licences_are_spdx_ids():
    assert load_registry().sources["overture"].licence_ids() == {
        "CDLA-Permissive-2.0",
        "Apache-2.0",
        "CC0-1.0",
    }


def test_unregistered_source_is_refused():
    with pytest.raises(SourceNotRegisteredError):
        load_registry().require("mapbox")


def _with_foursquare_disabled():
    registry = load_registry()
    registry.sources["foursquare"].enabled = False
    return registry


def test_both_sources_are_enabled_and_disabled_ones_are_refused():
    registry = load_registry()
    assert registry.enabled() == [
        "overture",
        "foursquare",
        "osm",
        "wikidata",
        "wikivoyage",
        "insideairbnb",
        "osm_lodging",
        "boc_fx",
    ]
    assert registry.require("foursquare").licence == "Apache-2.0"
    disabled = _with_foursquare_disabled()
    with pytest.raises(SourceDisabledError):
        disabled.require("foursquare")
    assert disabled.require("foursquare", allow_disabled=True).licence == "Apache-2.0"


def test_extract_refuses_a_disabled_source(tmp_path):
    from trippr_data.cities import load_cities
    from trippr_data.extract import foursquare

    with pytest.raises(SourceDisabledError):
        foursquare.extract(
            load_cities()[:1], out=tmp_path, date="2026-11-18", registry=_with_foursquare_disabled()
        )


def test_foursquare_needs_a_hugging_face_token(tmp_path, monkeypatch):
    """Without HF_TOKEN or a cached `hf auth login`, extraction stops before any network call."""
    from trippr_data.cities import load_cities
    from trippr_data.extract import foursquare

    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.setenv("HF_HOME", str(tmp_path / "no-hf"))
    monkeypatch.setattr(foursquare, "HF_TOKEN_CACHE", tmp_path / "no-token")
    with pytest.raises(foursquare.FoursquareNotConfiguredError):
        foursquare.extract(load_cities()[:1], out=tmp_path, date="2026-11-18", registry=load_registry())


def test_run_skips_an_unconfigured_foursquare(tmp_path, monkeypatch):
    """A scheduled run without a token keeps going with the other sources."""
    from trippr_data import cli
    from trippr_data.extract import foursquare

    calls = []

    def fake_overture(cities, **kwargs):
        calls.append("overture")
        return {"version": "test", "row_count": 0}

    def no_token(cities, **kwargs):
        raise foursquare.FoursquareNotConfiguredError("no token")

    def fake(name):
        def extract(cities, **kwargs):
            calls.append(name)
            return {"version": "test", "row_count": 0}

        return extract

    monkeypatch.setitem(cli.EXTRACTORS, "overture", fake_overture)
    monkeypatch.setitem(cli.EXTRACTORS, "foursquare", no_token)
    for name in ("osm", "wikivoyage", "wikidata"):  # never touch the network in tests
        monkeypatch.setitem(cli.EXTRACTORS, name, fake(name))
    args = cli.build_parser().parse_args(["--out", str(tmp_path), "extract", "--cities", "TYO"])
    # Wikidata runs last: it also fetches the QIDs that OpenStreetMap and Wikivoyage name
    assert cli._extract(args, load_registry(), tmp_path) == ["overture", "osm", "wikivoyage", "wikidata"]
    named = cli.build_parser().parse_args(["extract", "--cities", "TYO", "--source", "foursquare"])
    with pytest.raises(SystemExit):
        cli._extract(named, load_registry(), tmp_path)
