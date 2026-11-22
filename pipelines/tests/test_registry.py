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
        load_registry().require("osm")


def test_foursquare_is_disabled_until_the_owner_has_access():
    registry = load_registry()
    assert registry.enabled() == ["overture"]
    with pytest.raises(SourceDisabledError):
        registry.require("foursquare")
    assert registry.require("foursquare", allow_disabled=True).licence == "Apache-2.0"


def test_extract_refuses_a_disabled_source(tmp_path):
    from trippr_data.cities import load_cities
    from trippr_data.extract import foursquare

    with pytest.raises(SourceDisabledError):
        foursquare.extract(load_cities()[:1], out=tmp_path, date="2026-11-18", registry=load_registry())
