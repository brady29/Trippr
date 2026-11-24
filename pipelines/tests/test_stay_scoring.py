"""The stay score formulas, pinned with hand-computed values (src/trippr_data/stay/scoring.py)."""

from __future__ import annotations

import math

import pytest
from pydantic import ValidationError

from trippr_data.stay.config import Weights, load_stay_config
from trippr_data.stay.scoring import (
    UnitFacts,
    blend,
    cheaper_than_share,
    explain,
    parts_for,
    quiet_score,
    reviews_score,
    saturate,
    shrunk_rating,
    value_score,
    walkability_score,
)

CFG = load_stay_config()
PRICES = [10.0, 20.0, 20.0, 30.0, 40.0]  # sorted


def test_config_weights_sum_to_one_and_are_validated():
    assert sum(CFG.weights.model_dump().values()) == pytest.approx(1.0)
    with pytest.raises(ValidationError):
        Weights(value=0.5, walkability=0.5, quiet=0.5, reviews=0.5)


def test_saturate_is_zero_one_and_monotonic():
    assert saturate(0, 100) == 0.0
    assert saturate(None, 100) == 0.0
    assert saturate(100, 100) == 1.0
    assert saturate(1000, 100) == 1.0
    assert saturate(9, 99) == pytest.approx(math.log(10) / math.log(100))
    values = [saturate(n, 120) for n in range(0, 200, 5)]
    assert values == sorted(values)


def test_cheaper_than_share_counts_higher_prices_and_half_of_ties():
    assert cheaper_than_share(5, PRICES) == 1.0  # everything is dearer
    assert cheaper_than_share(50, PRICES) == 0.0
    assert cheaper_than_share(30, PRICES) == pytest.approx((1 + 0.5) / 5)  # 40 is higher; 30 ties with itself
    assert cheaper_than_share(20, PRICES) == pytest.approx((2 + 0.5 * 2) / 5)
    assert cheaper_than_share(None, PRICES) is None
    assert cheaper_than_share(10, []) is None


def test_value_score_is_the_share_times_100():
    assert value_score(30, PRICES) == pytest.approx(30.0)


def test_shrunk_rating_pulls_small_samples_toward_the_city():
    assert shrunk_rating(5.0, 10, 4.5, 10) == pytest.approx(4.75)
    assert shrunk_rating(5.0, 1000, 4.5, 10) == pytest.approx(5.0, abs=0.01)
    assert shrunk_rating(5.0, 3, None, 10) == 5.0
    assert shrunk_rating(None, 3, 4.5, 10) is None
    assert shrunk_rating(5.0, 0, 4.5, 10) is None


def test_reviews_score_maps_the_rating_range_and_clamps():
    rules = CFG.reviews  # 4.0 .. 5.0, prior weight 10
    assert reviews_score(4.5, 50, 4.5, rules) == pytest.approx(50.0)
    assert reviews_score(5.0, 10, 4.5, rules) == pytest.approx(75.0)  # shrunk to 4.75
    assert reviews_score(3.0, 10_000, 4.5, rules) == 0.0
    assert reviews_score(5.0, 10_000, 5.0, rules) == pytest.approx(100.0)
    assert reviews_score(None, 5, 4.5, rules) is None


def test_few_five_star_listings_do_not_beat_many_good_ones():
    few = reviews_score(5.0, 3, 4.5, CFG.reviews)
    many = reviews_score(4.85, 200, 4.5, CFG.reviews)
    assert few is not None and many is not None
    assert many > few


def test_walkability_and_quiet_proxies():
    assert walkability_score(0, CFG.walkability) == 0.0
    assert walkability_score(CFG.walkability.saturation_places, CFG.walkability) == pytest.approx(100.0)
    assert walkability_score(None, CFG.walkability) is None
    assert quiet_score(0, CFG.quiet) == 100.0
    assert quiet_score(CFG.quiet.saturation_nightlife, CFG.quiet) == pytest.approx(0.0)
    assert quiet_score(3, CFG.quiet) > quiet_score(6, CFG.quiet)
    assert quiet_score(None, CFG.quiet) is None


def test_blend_rescales_to_the_parts_present():
    w = CFG.weights
    full = blend({"value": 80, "reviews": 60, "walkability": 40, "quiet": 20}, w, 0.5)
    assert full.score == pytest.approx(0.4 * 80 + 0.1 * 60 + 0.3 * 40 + 0.2 * 20)
    assert full.used == ("value", "reviews", "walkability", "quiet")
    assert full.weight_coverage == 1.0
    places_only = blend({"value": None, "reviews": None, "walkability": 40, "quiet": 100}, w, 0.5)
    assert places_only.score == pytest.approx((0.3 * 40 + 0.2 * 100) / 0.5)
    assert places_only.used == ("walkability", "quiet")
    assert places_only.weight_coverage == pytest.approx(0.5)


def test_blend_refuses_a_score_from_too_little_weight():
    thin = blend({"value": None, "reviews": 90, "walkability": None, "quiet": None}, CFG.weights, 0.5)
    assert thin.score is None
    assert thin.used == ("reviews",)
    assert blend({}, CFG.weights, 0.5).score is None


def test_blend_stays_within_0_100():
    top = blend({"value": 100, "reviews": 100, "walkability": 100, "quiet": 100}, CFG.weights, 0.5)
    bottom = blend({"value": 0, "reviews": 0, "walkability": 0, "quiet": 0}, CFG.weights, 0.5)
    assert (top.score, bottom.score) == (100.0, 0.0)


def test_parts_need_enough_listings_for_value_and_reviews():
    kwargs = dict(
        price_pp=20.0,
        city_prices_sorted=PRICES,
        rating=4.8,
        city_rating=4.5,
        n_places=60,
        n_nightlife=2,
        cfg=CFG,
    )
    few = parts_for(n_priced=CFG.min_priced_listings - 1, n_rated=CFG.min_priced_listings - 1, **kwargs)
    assert few["value"] is None and few["reviews"] is None
    assert few["walkability"] is not None and few["quiet"] is not None
    enough = parts_for(n_priced=CFG.min_priced_listings, n_rated=CFG.min_priced_listings, **kwargs)
    assert enough["value"] == pytest.approx(60.0)
    assert enough["reviews"] is not None


def test_explain_writes_facts_not_a_bare_number():
    text = explain(
        UnitFacts(
            city_name="Tokyo",
            cheaper_share=0.7,
            median_price_cad=120,
            median_price_pp_cad=45,
            median_rating=4.8,
            n_rated=35,
            n_priced=40,
            n_places=85,
            n_nightlife=1,
        )
    )
    assert text == (
        "Cheaper than 70% of Tokyo listings: median CAD 120 a night (CAD 45 a person), from 40 listings; "
        "reviews 4.80 median across 35 rated listings; 85 places within 600 m; "
        "1 bar or nightlife venue within 300 m."
    )
    assert explain(UnitFacts(city_name="Osaka")) == "Not enough data for this unit."
