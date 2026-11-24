"""End to end through the fake client: plan, estimate, guard, submit, collect, cache, resume, output."""

import json
from pathlib import Path

import duckdb
import pytest

from trippr_data.enrich.batches import MAX_ATTEMPTS
from trippr_data.enrich.estimate import BudgetExceededError
from trippr_data.enrich.prompt import build_params
from trippr_data.enrich.run import ConfirmationRequiredError, enrich_places, make_runner

from .conftest import make_place
from .fakes import FakeAnthropic, default_responder

MODEL = "claude-haiku-5-5"
QUIET = {"report": lambda _: None, "sleep": lambda _: None}


def run(client, places, root, **kw):
    args = {"model": MODEL, "effort": "low", "budget_usd": 10.0, "yes": True, **QUIET}
    args.update(kw)
    return enrich_places(client, places, root, **args)


def read_parquet(path: Path) -> list[dict]:
    con = duckdb.connect(config={"TimeZone": "UTC"})
    cur = con.execute(f"SELECT * FROM read_parquet('{path.as_posix()}') ORDER BY place_id")
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r, strict=True)) for r in cur.fetchall()]


def test_first_run_enriches_everything_and_writes_parquet_with_provenance(places, tmp_path):
    client = FakeAnthropic()
    out = tmp_path / "enriched.parquet"
    result = run(client, places, tmp_path / "root", output=out)

    assert client.requests_sent == 5 and len(client.created) == 1
    assert result.n_enriched == 5 and result.n_missing == 0
    rows = read_parquet(out)
    assert [r["place_id"] for r in rows] == ["p1", "p2", "p3", "p4", "p5"]
    senso = rows[0]
    assert senso["tags"] == ["temple_shrine"]
    assert "浅草寺" in senso["summary"]  # CJK survives the whole round trip
    assert rows[1]["summary"].startswith("วัดโพธิ์")
    assert senso["ai"] is True
    assert senso["ai_label"] == "Summary written by AI from OpenStreetMap and Wikivoyage"
    prov = senso["provenance"]
    assert prov["summary_ai"] is True
    assert prov["model"] == MODEL
    assert prov["prompt_version"]
    assert prov["batch_id"] == client.created[0]
    assert prov["input_sources"] == ["osm", "wikivoyage"]
    assert rows[2]["provenance"]["input_sources"] == []  # no description was read: no source is named
    assert rows[2]["ai_label"] == "Summary written by AI"
    assert rows[2]["is_generic_name"] is False and rows[2]["display_name"] is None


def test_second_run_pays_for_nothing_and_third_run_only_for_the_changed_place(places, tmp_path):
    root = tmp_path / "root"
    client = FakeAnthropic()
    run(client, places, root)
    sent = client.requests_sent

    again = run(client, places, root)
    assert client.requests_sent == sent and again.n_cached == 5 and again.n_to_submit == 0
    assert again.estimate.total_usd == 0

    changed = [
        *places[:4],
        make_place("p5", "Hồ Hoàn Kiếm", "nature_spot", "HAN", address="Hoan Kiem, Hanoi"),
    ]
    third = run(client, changed, root)
    assert third.n_cached == 4 and third.n_to_submit == 1
    assert client.requests_sent == sent + 1


def test_identical_places_share_one_request(tmp_path):
    twins = [make_place("a", "Same Temple"), make_place("b", "Same Temple")]
    client = FakeAnthropic()
    out = tmp_path / "e.parquet"
    run(client, twins, tmp_path / "root", output=out)
    assert client.requests_sent == 1
    assert [r["place_id"] for r in read_parquet(out)] == ["a", "b"]


def test_changing_the_model_or_prompt_version_re_enriches(places, tmp_path, monkeypatch):
    root = tmp_path / "root"
    client = FakeAnthropic()
    run(client, places, root)
    run(client, places, root, model="claude-sonnet-5-5")
    assert client.requests_sent == 10
    monkeypatch.setattr("trippr_data.enrich.run.PROMPT_VERSION", "next-version")
    run(client, places, root)
    assert client.requests_sent == 15


def test_dry_run_estimates_and_changes_nothing(places, tmp_path):
    root = tmp_path / "root"
    client = FakeAnthropic()
    result = run(client, places, root, dry_run=True, yes=False)
    assert result.estimate.n_requests == 5 and result.estimate.method == "count_tokens"
    assert client.requests_sent == 0 and not root.exists()
    offline = run(None, places, root, dry_run=True, yes=False)
    assert offline.estimate.method == "heuristic" and not root.exists()


def test_nothing_is_submitted_without_yes(places, tmp_path):
    client = FakeAnthropic()
    with pytest.raises(ConfirmationRequiredError, match="--yes"):
        run(client, places, tmp_path / "root", yes=False)
    assert client.requests_sent == 0


def test_over_budget_stops_before_anything_is_sent(places, tmp_path):
    client = FakeAnthropic()
    with pytest.raises(BudgetExceededError, match="over the"):
        run(client, places, tmp_path / "root", budget_usd=0.000001)
    assert client.requests_sent == 0 and client.created == []


def test_budget_is_rechecked_per_batch_and_the_run_resumes(places, tmp_path):
    root = tmp_path / "root"
    client = FakeAnthropic()
    est = run(client, places, root, dry_run=True).estimate
    per_place = est.total_usd / 5
    # the cap fits three places; the estimate for five is over it, so it stops before the first batch
    with pytest.raises(BudgetExceededError):
        run(client, places, root, budget_usd=per_place * 3, batch_size=2)
    assert client.requests_sent == 0
    # the per-chunk check itself: pass the guard, then fail part-way when chunks add up past the cap
    runner = make_runner(client, root, MODEL)
    reqs = {f"{i:064x}": build_params(places[0], MODEL, "low") for i in range(4)}
    with pytest.raises(BudgetExceededError, match="Stopped; rerun resumes"):
        runner.submit(reqs, usd_per_request=1.0, budget_usd=2.5, batch_size=1)
    assert client.requests_sent == 2
    assert len(runner.state.in_flight()) == 2


def test_no_wait_then_resume_collects_without_resubmitting(places, tmp_path):
    root = tmp_path / "root"
    client = FakeAnthropic(polls_before_ended=2)
    first = run(client, places, root, wait=False)
    assert first.batch_ids == ["msgbatch_fake001"] and first.collected.succeeded == 0
    assert make_runner(client, root, MODEL).state.in_flight()

    out = tmp_path / "e.parquet"
    second = run(client, places, root, wait=False, output=out)  # one poll: still running
    assert second.n_in_flight == 5 and second.n_to_submit == 0 and client.requests_sent == 5
    assert second.n_enriched == 0

    third = run(client, places, root, wait=True, output=out)
    assert client.requests_sent == 5, "an in-flight batch is never submitted twice"
    assert third.collected.succeeded == 5 and third.n_enriched == 5


def test_state_survives_a_crash_between_submit_and_collect(places, tmp_path):
    root = tmp_path / "root"
    client = FakeAnthropic()
    run(client, places, root, wait=False)
    state = json.loads((root / "enrich.state.json").read_text(encoding="utf-8"))
    assert state["batches"][0]["status"] == "in_progress" and len(state["batches"][0]["keys"]) == 5
    fresh = make_runner(client, root, MODEL)  # a brand new process reading the same files
    summary = fresh.collect_ready()
    assert summary.succeeded == 5
    assert (
        json.loads((root / "enrich.state.json").read_text(encoding="utf-8"))["batches"][0]["status"]
        == "collected"
    )


def test_invalid_and_errored_answers_are_not_cached_and_are_retried_then_given_up(places, tmp_path):
    root = tmp_path / "root"

    def flaky(params):
        text = default_responder(params)
        name = params["messages"][0]["content"]
        if "Shibuya Sky" in name:
            return json.dumps({"tags": ["not_a_category"]})  # fails the schema
        if "Wat Pho" in name or "วัดโพธิ์" in name:
            return RuntimeError("overloaded")  # the batch result is an error
        if "경복궁" in name:
            return "<<max_tokens>>"  # cut off
        return text

    client = FakeAnthropic(flaky)
    result = run(client, places, root)
    assert result.collected.succeeded == 2 and result.collected.failed == 3
    assert result.n_to_submit == 5
    runner = make_runner(client, root, MODEL)
    assert len(runner.cache) == 2
    errors = " ".join(result.collected.errors)
    assert "tags not in the taxonomy" in errors and "errored" in errors and "max_tokens" in errors

    for _ in range(MAX_ATTEMPTS - 1):
        run(client, places, root)
    last = run(client, places, root)
    assert last.n_exhausted == 3 and last.n_to_submit == 0
    sent = client.requests_sent
    run(client, places, root)
    assert client.requests_sent == sent, "keys out of attempts are not sent again"

    out = tmp_path / "e.parquet"
    final = run(client, places, root, output=out)
    assert final.n_enriched == 2 and final.n_missing == 3


def test_empty_summary_is_not_labelled_ai(tmp_path):
    def quiet(params):
        return json.dumps(
            {
                "tags": ["museum"],
                "summary": "",
                "duration_min": None,
                "best_time": None,
                "indoor": None,
                "price_level": None,
                "good_for": [],
                "display_name": None,
                "is_generic_name": False,
            }
        )

    out = tmp_path / "e.parquet"
    run(FakeAnthropic(quiet), [make_place("a", "X", "museum")], tmp_path / "root", output=out)
    [row] = read_parquet(out)
    assert row["ai"] is True and row["ai_label"] is None and row["provenance"]["summary_ai"] is False
    assert row["duration_min"] is None


def test_enriching_zero_places_writes_an_empty_parquet(tmp_path):
    out = tmp_path / "e.parquet"
    run(FakeAnthropic(), [], tmp_path / "root", output=out)
    assert read_parquet(out) == []


def test_torn_cache_line_is_ignored(places, tmp_path):
    root = tmp_path / "root"
    client = FakeAnthropic()
    run(client, places, root)
    with open(root / "enrich.cache.jsonl", "a", encoding="utf-8") as fh:
        fh.write('{"key": "abc", "val')  # a crash mid-write
    assert len(make_runner(client, root, MODEL).cache) == 5
