import json
from collections import Counter

import pytest

from trippr_data.enrich.evaluate import (
    EVAL_SET_PATH,
    TARGET_TAG_F1,
    EvalPlace,
    Reference,
    load_eval_set,
    passes_targets,
    render_comparison,
    render_report,
    run_eval,
    score,
    script_of,
)
from trippr_data.enrich.inputs import taxonomy

from .conftest import make_place
from .fakes import FakeAnthropic, default_responder, reference_responder

QUIET = {"report": lambda _: None, "sleep": lambda _: None}


@pytest.fixture(scope="module")
def eval_items() -> list[EvalPlace]:
    return load_eval_set()


# ---- the eval set ----------------------------------------------------------------------------------


def test_eval_set_is_big_and_spread_across_countries_and_scripts(eval_items):
    assert 140 <= len(eval_items) <= 175
    assert len({i.place.place_id for i in eval_items}) == len(eval_items)
    countries = Counter(i.country for i in eval_items)
    assert len(countries) >= 12
    assert max(countries.values()) <= 0.25 * len(eval_items)
    scripts = Counter(i.script for i in eval_items)
    assert {"latin", "cjk", "hangul", "thai", "khmer", "lao", "devanagari", "cyrillic"} <= set(scripts)
    assert all(scripts[s] >= 1 for s in scripts)


def test_every_eval_place_is_labelled_with_taxonomy_tags_and_sane_values(eval_items):
    for item in eval_items:
        r = item.ref
        assert 1 <= len(r.tags) <= 4 and set(r.tags) <= set(taxonomy()), item.place.place_id
        if r.generic and r.duration_min is None:
            continue  # a place known only as "Tokyo, Japan" has no knowable visit length
        assert r.duration_min is not None and 15 <= r.duration_min <= 600
        assert r.best_time in {"morning", "afternoon", "evening", "night", "any"}
        assert item.place.name_local or item.script == "latin"


def test_eval_set_has_places_without_descriptions_and_a_few_chains(eval_items):
    assert any(not i.place.description for i in eval_items)
    assert sum(1 for i in eval_items if i.place.description) > 0.8 * len(eval_items)


def test_eval_set_has_the_formal_and_city_named_records_seen_in_the_bundle(eval_items):
    generic = {i.place.place_id: i for i in eval_items if i.ref.generic}
    assert len(generic) >= 10
    assert generic["gn-001"].ref.display == "Tokyo National Museum"
    assert generic["gn-001"].place.name == "Independent Administrative Institution National Museum"
    assert generic["gn-002"].place.name == "Tokyo, Japan" and generic["gn-002"].ref.display is None
    assert sum(1 for i in eval_items if not i.ref.generic) > 150  # ordinary names, chains included
    assert all(i.ref.display for i in eval_items if i.ref.display is not None)


def test_generic_name_and_display_name_metrics():
    items = [
        generic_item("a", "Tokyo, Japan", generic=True),
        generic_item(
            "b",
            "Independent Administrative Institution National Museum",
            generic=True,
            display="Tokyo National Museum",
        ),
        generic_item("c", "Kinkaku-ji", generic=False),
    ]
    preds = {
        "a": pred(["landmark"], is_generic=True),
        "b": pred(["museum"], is_generic=True, display="tokyo  national museum"),
        "c": pred(["landmark"], is_generic=True),  # a false alarm on a real name
    }
    m = score(items, preds)
    assert m["generic_recall"] == 1.0 and m["generic_precision"] == pytest.approx(2 / 3)
    assert m["display_name_match"] == 1.0
    assert (
        score(items, {**preds, "b": pred(["museum"], is_generic=True, display="Kyoto National Museum")})[
            "display_name_match"
        ]
        == 0.0
    )


def test_eval_file_is_utf8_json_lines():
    for line in EVAL_SET_PATH.read_text(encoding="utf-8").splitlines():
        json.loads(line)


def test_script_detection():
    assert script_of("浅草寺") == "cjk"
    assert script_of("ひらがな") == "cjk"
    assert script_of("경복궁") == "hangul"
    assert script_of("วัดโพธิ์") == "thai"
    assert script_of("Hồ Hoàn Kiếm") == "latin"
    assert script_of(None, "Чингис") == "cyrillic"


# ---- scoring ---------------------------------------------------------------------------------------


def item(pid, tags, dur=60, best="morning", indoor=None, name="Place", category="museum"):
    return EvalPlace(
        make_place(pid, name, category),
        Reference(tags=tags, duration_min=dur, best_time=best, indoor=indoor),
        "JP",
        "latin",
    )


def generic_item(pid, name, *, generic, display=None):
    return EvalPlace(
        make_place(pid, name, "museum"),
        Reference(tags=["museum"], generic=generic, display=display),
        "JP",
        "latin",
    )


def pred(tags, dur=60, best="morning", indoor=None, summary="", is_generic=False, display=None):
    return {
        "tags": tags,
        "summary": summary,
        "duration_min": dur,
        "best_time": best,
        "indoor": indoor,
        "price_level": None,
        "good_for": [],
        "display_name": display,
        "is_generic_name": is_generic,
    }


def test_tag_precision_recall_f1_are_micro_averaged():
    items = [item("a", ["museum", "gallery"]), item("b", ["cafe"])]
    preds = {"a": pred(["museum", "bar"]), "b": pred(["cafe"])}
    m = score(items, preds)
    # tp=2 (museum, cafe), fp=1 (bar), fn=1 (gallery)
    assert m["tag_precision"] == pytest.approx(2 / 3)
    assert m["tag_recall"] == pytest.approx(2 / 3)
    assert m["tag_f1"] == pytest.approx(2 / 3)


def test_duration_tolerance_and_best_time_and_indoor():
    items = [item("a", ["museum"], 60, "morning", True), item("b", ["museum"], 60, "evening", False)]
    preds = {"a": pred(["museum"], 90, "morning", True), "b": pred(["museum"], 91, "night", True)}
    m = score(items, preds, tolerance=30)
    assert m["duration_within_tolerance"] == 0.5  # 30 min off passes, 31 min off does not
    assert m["best_time_accuracy"] == 0.5
    assert m["indoor_accuracy"] == 0.5
    assert score(items, preds, tolerance=60)["duration_within_tolerance"] == 1.0


def test_a_place_with_no_valid_answer_counts_against_every_metric():
    items = [item("a", ["museum"]), item("b", ["cafe"])]
    m = score(items, {"a": pred(["museum"]), "b": None})
    assert m["valid_rate"] == 0.5
    assert m["tag_recall"] == 0.5 and m["tag_precision"] == 1.0
    assert m["duration_within_tolerance"] == 0.5 and m["best_time_accuracy"] == 0.5


def test_unsupported_summary_rate_uses_rules_and_judge_verdicts():
    items = [item("a", ["museum"], name="Alpha"), item("b", ["museum"], name="Beta")]
    preds = {
        "a": pred(["museum"], summary="Alpha is a museum in Tokyo."),
        "b": pred(["museum"], summary="Beta is a museum in Tokyo founded in 1899."),
    }
    m = score(items, preds)
    assert m["summary_rule_unsupported_rate"] == 0.5 and m["summary_judge_unsupported_rate"] is None
    verdicts = {
        "a": {"supported": True, "unsupported_claims": []},
        "b": {"supported": False, "unsupported_claims": ["1899"]},
    }
    m = score(items, preds, verdicts)
    assert m["summary_judge_unsupported_rate"] == 0.5 and m["summaries_judged"] == 2


def test_targets():
    good = {
        "tag_f1": 0.9,
        "valid_rate": 1.0,
        "summary_rule_unsupported_rate": 0.0,
        "summary_judge_unsupported_rate": None,
    }
    assert all(passes_targets(good).values())
    assert not passes_targets({**good, "tag_f1": TARGET_TAG_F1 - 0.01})["tag_f1"]
    assert not passes_targets({**good, "summary_judge_unsupported_rate": 0.05})["unsupported_summaries"]
    assert not passes_targets({**good, "valid_rate": 0.9})["valid_answers"]


# ---- running ---------------------------------------------------------------------------------------


def test_perfect_model_scores_perfectly_on_the_real_eval_set(eval_items, tmp_path):
    client = FakeAnthropic(reference_responder(eval_items))
    rep = run_eval(
        client,
        eval_items,
        tmp_path / "m",
        model="claude-haiku-5-5",
        effort="low",
        budget_usd=10,
        yes=True,
        **QUIET,
    )
    assert rep.metrics["n"] == len(eval_items)
    assert rep.metrics["valid_rate"] == 1.0
    assert rep.metrics["tag_f1"] == 1.0
    assert rep.metrics["duration_within_tolerance"] == 1.0 and rep.metrics["best_time_accuracy"] == 1.0
    assert rep.meets_targets
    assert set(rep.by_script) >= {"cjk", "thai", "latin"} and "JP" in rep.by_country
    assert rep.cost["enrich_usd"] > 0 and rep.cost["enrich_usd_per_1000_places"] > 0
    assert rep.cost["avg_output_tokens"] == 120
    text = render_report(rep)
    assert "meets the targets" in text and "script: thai" in text and "per 1,000 places" in text
    # a rerun is free: every answer is cached
    sent = client.requests_sent
    run_eval(
        client,
        eval_items,
        tmp_path / "m",
        model="claude-haiku-5-5",
        effort="low",
        budget_usd=10,
        yes=True,
        **QUIET,
    )
    assert client.requests_sent == sent


def test_a_weak_model_misses_the_targets_and_the_report_says_where(eval_items, tmp_path):
    def all_cafe(params):  # tags every place "cafe", 60 minutes, any time of day
        return json.dumps({**json.loads(default_responder(params)), "tags": ["cafe"]}, ensure_ascii=False)

    client = FakeAnthropic(all_cafe)
    rep = run_eval(
        client,
        eval_items,
        tmp_path / "m",
        model="claude-haiku-5-5",
        effort="low",
        budget_usd=10,
        yes=True,
        **QUIET,
    )
    assert not rep.meets_targets and not rep.targets["tag_f1"]
    assert rep.metrics["tag_f1"] < 0.2
    assert rep.metrics["best_time_accuracy"] < 0.5
    assert rep.misses and "MISSES" in render_report(rep)


def test_judge_runs_through_the_batch_api_and_is_cached(eval_items, tmp_path):
    items = eval_items[:12]

    def responder(params):
        if "<summary>" in params["messages"][0]["content"]:
            bad = "Place 0" in params["messages"][0]["content"]
            return json.dumps({"supported": not bad, "unsupported_claims": ["x"] if bad else []})
        return reference_responder(items)(params)

    client = FakeAnthropic(responder)
    kw = {
        "model": "claude-haiku-5-5",
        "effort": "low",
        "budget_usd": 10,
        "yes": True,
        "judge_model": "claude-haiku-5-5",
        **QUIET,
    }
    rep = run_eval(client, items, tmp_path / "m", **kw)
    assert rep.metrics["summaries_judged"] == 12
    assert rep.metrics["summary_judge_unsupported_rate"] == 0.0
    assert "judge_usd" in rep.cost and len(client.created) == 2  # one enrich batch, one judge batch
    sent = client.requests_sent
    run_eval(client, items, tmp_path / "m", **kw)
    assert client.requests_sent == sent


def test_eval_dry_run_estimates_enrich_and_judge_and_spends_nothing(eval_items, tmp_path):
    client = FakeAnthropic()
    rep = run_eval(
        client,
        eval_items,
        tmp_path / "m",
        model="claude-haiku-5-5",
        effort="low",
        budget_usd=10,
        dry_run=True,
        judge_model="claude-haiku-5-5",
        extrapolate_to=8000,
        **QUIET,
    )
    assert rep.estimate.n_requests == 8000 and rep.judge_estimate.n_requests == 8000
    assert client.requests_sent == 0 and not (tmp_path / "m").exists()


def test_compare_picks_the_cheapest_model_that_meets_the_targets(eval_items, tmp_path):
    reports = []
    for model, responder in (
        ("claude-haiku-5-5", default_responder),  # misses
        ("claude-sonnet-5-5", reference_responder(eval_items)),  # meets, but costs more
    ):
        client = FakeAnthropic(responder)
        reports.append(
            run_eval(
                client,
                eval_items,
                tmp_path / model,
                model=model,
                effort="low",
                budget_usd=100,
                yes=True,
                **QUIET,
            )
        )
    text = render_comparison(reports)
    assert "Cheapest model that meets the targets: claude-sonnet-5-5" in text
    assert reports[1].cost["enrich_usd_per_1000_places"] > reports[0].cost["enrich_usd_per_1000_places"]
