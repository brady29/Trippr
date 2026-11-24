import pytest

from trippr_data.enrich.estimate import (
    BudgetExceededError,
    check_budget,
    estimate_requests,
    heuristic_tokens,
)
from trippr_data.enrich.pricing import BATCH_DISCOUNT, price_for, usage_cost
from trippr_data.enrich.prompt import build_params

from .fakes import FakeAnthropic


def params_for(places, model="claude-haiku-5-5"):
    return [build_params(p, model, "low") for p in places]


def test_heuristic_counts_cjk_and_thai_per_character_and_latin_per_word_ish():
    assert heuristic_tokens("") == 0
    assert heuristic_tokens("浅草寺" * 10) > heuristic_tokens("a" * 30)
    assert heuristic_tokens("วัดโพธิ์" * 5) > heuristic_tokens("a" * 20)


def test_count_tokens_estimate_samples_and_extrapolates(places):
    client = FakeAnthropic()
    est = estimate_requests(params_for(places), "claude-haiku-5-5", client=client, sample_size=3)
    assert est.method == "count_tokens"
    assert est.sampled == 3
    assert est.n_requests == 5
    assert client.count_calls == 3 + 1  # the sample, plus the shared prefix on its own
    assert client.requests_sent == 0  # estimating never submits anything
    assert est.prefix_tokens < est.avg_input_tokens

    scaled = estimate_requests(
        params_for(places), "claude-haiku-5-5", client=FakeAnthropic(), sample_size=3, extrapolate_to=8000
    )
    assert scaled.n_requests == 8000
    assert scaled.total_usd == pytest.approx(est.total_usd / 5 * 8000, rel=1e-6)


def test_cost_arithmetic_matches_the_price_sheet(places):
    est = estimate_requests(params_for(places), "claude-haiku-5-5", client=None, output_tokens=400)
    p = price_for("claude-haiku-5-5")
    n = est.n_requests
    assert est.method == "heuristic"
    assert est.input_usd == pytest.approx(n * est.avg_input_tokens * p.input / 1e6 * BATCH_DISCOUNT)
    assert est.output_usd == pytest.approx(n * 400 * p.output / 1e6 * BATCH_DISCOUNT)
    assert est.total_usd == pytest.approx(est.input_usd + est.output_usd)
    assert est.with_cache_usd <= est.total_usd * 1.2  # caching can only help once n is large
    assert est.worst_case_usd >= est.total_usd


def test_sonnet_costs_twenty_times_haiku_per_token(places):
    haiku = estimate_requests(params_for(places), "claude-haiku-5-5", client=None)
    sonnet = estimate_requests(params_for(places, "claude-sonnet-5-5"), "claude-sonnet-5-5", client=None)
    assert sonnet.total_usd == pytest.approx(haiku.total_usd * 20, rel=1e-6)


def test_empty_request_list_costs_nothing():
    assert estimate_requests([], "claude-haiku-5-5", client=None).total_usd == 0


def test_budget_guard(places):
    est = estimate_requests(params_for(places), "claude-haiku-5-5", client=None, extrapolate_to=10_000_000)
    with pytest.raises(BudgetExceededError, match="Nothing was submitted"):
        check_budget(est, 10.0)
    check_budget(est, est.total_usd + 1)


def test_render_mentions_the_cap_and_the_method(places):
    text = estimate_requests(params_for(places), "claude-haiku-5-5", client=None).render(10.0)
    assert "TOTAL" in text and "within" in text and "heuristic" in text.lower()


def test_unknown_model_has_no_price():
    with pytest.raises(ValueError, match="No price on file"):
        price_for("claude-mystery-9")


def test_usage_cost_uses_batch_and_cache_rates():
    usage = {
        "input_tokens": 1_000_000,
        "output_tokens": 1_000_000,
        "cache_read_input_tokens": 1_000_000,
        "cache_creation_input_tokens": 1_000_000,
    }
    # haiku standard: 0.10 in + 0.50 out + 0.01 cache read + 0.20 cache write (2x, 1h) = 0.81, half off in a batch
    assert usage_cost(usage, "claude-haiku-5-5") == pytest.approx(0.405)
