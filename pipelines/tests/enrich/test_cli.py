import json
from pathlib import Path

import duckdb
import pytest

from trippr_data.cli import main
from trippr_data.enrich import client as client_mod
from trippr_data.enrich.evaluate import load_eval_set
from trippr_data.enrich.settings import budget_usd

from .fakes import FakeAnthropic, reference_responder

DATE = "2026-11-23"


@pytest.fixture
def places_file(tmp_path: Path) -> Path:
    path = tmp_path / "places.jsonl"
    rows = [
        {
            "place_id": "a",
            "name": "浅草寺",
            "name_en": "Senso-ji",
            "category": "temple_shrine",
            "city_code": "TYO",
        },
        {
            "place_id": "b",
            "name": "วัดโพธิ์",
            "name_en": "Wat Pho",
            "category": "temple_shrine",
            "city_code": "BKK",
        },
        {"place_id": "c", "name": "Shibuya Sky", "category": "viewpoint", "city_code": "TYO"},
    ]
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")
    return path


def use_fake(monkeypatch: pytest.MonkeyPatch, fake: FakeAnthropic) -> FakeAnthropic:
    monkeypatch.setattr(client_mod, "make_client", lambda: fake)
    return fake


def enrich_args(tmp_path: Path, places_file: Path, *extra: str) -> list[str]:
    return ["--out", str(tmp_path / "out"), "enrich", "--date", DATE, "--input", str(places_file), *extra]


def test_dry_run_offline_needs_no_key_and_no_client(tmp_path, places_file, capsys):
    assert main(enrich_args(tmp_path, places_file, "--dry-run", "--offline")) == 0
    out = capsys.readouterr().out
    assert "TOTAL" in out and "nothing was spent" in out and "heuristic" in out.lower()
    assert not (tmp_path / "out").exists()


def test_dry_run_with_a_client_uses_token_counting(tmp_path, places_file, monkeypatch, capsys):
    fake = use_fake(monkeypatch, FakeAnthropic())
    assert main(enrich_args(tmp_path, places_file, "--dry-run", "--extrapolate-to", "8000")) == 0
    assert "8,000 requests" in capsys.readouterr().out
    assert fake.count_calls > 0 and fake.requests_sent == 0


def test_missing_key_is_a_clear_error(tmp_path, places_file, caplog):
    assert main(enrich_args(tmp_path, places_file, "--dry-run")) == 4
    assert "ANTHROPIC_API_KEY is not set" in caplog.text


def test_real_client_reads_the_key_from_the_environment_only(monkeypatch):
    import anthropic

    seen = {}
    monkeypatch.setattr(anthropic, "Anthropic", lambda **kw: seen.update(kw) or "client")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")
    assert client_mod.make_client() == "client"
    assert "api_key" not in seen  # the SDK picks the key up from the environment itself


def test_spending_requires_yes_and_the_cap_is_enforced(tmp_path, places_file, monkeypatch):
    fake = use_fake(monkeypatch, FakeAnthropic())
    assert main(enrich_args(tmp_path, places_file)) == 3  # no --yes
    assert main(enrich_args(tmp_path, places_file, "--yes", "--budget-usd", "0.0000001")) == 3
    assert fake.requests_sent == 0 and fake.created == []


def test_enrich_writes_the_parquet_and_reruns_for_free(tmp_path, places_file, monkeypatch, capsys):
    fake = use_fake(monkeypatch, FakeAnthropic())
    assert main(enrich_args(tmp_path, places_file, "--yes")) == 0
    target = tmp_path / "out" / "enriched" / DATE / "enrichment.parquet"
    assert target.is_file()
    assert "Wrote 3 enriched places" in capsys.readouterr().out
    assert fake.requests_sent == 3
    assert main(enrich_args(tmp_path, places_file, "--yes")) == 0
    assert fake.requests_sent == 3


def test_budget_comes_from_the_environment(tmp_path, places_file, monkeypatch):
    fake = use_fake(monkeypatch, FakeAnthropic())
    monkeypatch.setenv("ENRICH_BUDGET_USD", "0.0000001")
    assert main(enrich_args(tmp_path, places_file, "--yes")) == 3
    monkeypatch.setenv("ENRICH_BUDGET_USD", "10")
    assert main(enrich_args(tmp_path, places_file, "--yes")) == 0
    assert fake.requests_sent == 3


def test_no_wait_then_status_then_collect(tmp_path, places_file, monkeypatch, capsys):
    fake = use_fake(monkeypatch, FakeAnthropic(polls_before_ended=1))
    assert main(enrich_args(tmp_path, places_file, "--yes", "--no-wait")) == 0
    assert "still running" in capsys.readouterr().out
    out = ["--out", str(tmp_path / "out")]
    assert main([*out, "enrich-status"]) == 0
    assert "in_progress" in capsys.readouterr().out
    assert main([*out, "enrich-status", "--collect"]) == 0  # first poll: not ended yet
    assert main([*out, "enrich-status", "--collect"]) == 0
    status = capsys.readouterr().out
    assert "collected" in status and "3 answers cached" in status
    assert fake.requests_sent == 3


def test_bad_inputs_exit_2(tmp_path, places_file, caplog):
    assert main(["--out", str(tmp_path / "out"), "enrich", "--date", DATE]) == 2  # no curated file yet
    assert "not found" in caplog.text
    assert main(enrich_args(tmp_path, places_file, "--offline")) == 2  # --offline needs --dry-run
    assert main(enrich_args(tmp_path, places_file, "--extrapolate-to", "10")) == 2


def test_eval_enrich_end_to_end(tmp_path, monkeypatch, capsys):
    items = load_eval_set()
    use_fake(monkeypatch, FakeAnthropic(reference_responder(items)))
    out = ["--out", str(tmp_path / "out")]
    assert main([*out, "eval-enrich", "--yes", "--limit", "40"]) == 0
    text = capsys.readouterr().out
    assert "Enrichment eval: claude-haiku-5-5" in text and "meets the targets" in text
    root = tmp_path / "out" / "enrich-eval" / "claude-haiku-5-5"
    report = json.loads((root / "report.json").read_text(encoding="utf-8"))
    assert report["metrics"]["n"] == 40 and report["targets"]["tag_f1"] is True
    assert (root / "report.md").is_file()


def test_eval_enrich_dry_run_offline_and_compare(tmp_path, monkeypatch, capsys):
    assert (
        main(
            [
                "--out",
                str(tmp_path / "o"),
                "eval-enrich",
                "--dry-run",
                "--offline",
                "--extrapolate-to",
                "8000",
            ]
        )
        == 0
    )
    assert "8,000 requests" in capsys.readouterr().out
    items = load_eval_set()
    use_fake(monkeypatch, FakeAnthropic(reference_responder(items)))
    out = ["--out", str(tmp_path / "out")]
    assert main([*out, "eval-enrich", "--yes", "--limit", "30", "--models", "haiku,sonnet"]) == 0
    assert "Cheapest model that meets the targets: claude-haiku-5-5" in capsys.readouterr().out


def test_enrich_reads_the_newest_curated_run_by_default(curated_out, monkeypatch, capsys):
    from trippr_data.enrich.inputs import default_input, read_places

    expected = read_places(default_input(curated_out))
    fake = use_fake(monkeypatch, FakeAnthropic())
    out = ["--out", str(curated_out)]
    assert main([*out, "enrich", "--dry-run", "--offline"]) == 0
    assert f"{len(expected)} places" in capsys.readouterr().out
    assert main([*out, "enrich", "--yes"]) == 0
    assert fake.requests_sent == len({p.content_hash() for p in expected})
    target = curated_out / "enriched" / "2026-11-18" / "enrichment.parquet"
    query = f"SELECT place_id FROM read_parquet('{target.as_posix()}')"
    assert {r[0] for r in duckdb.connect().execute(query).fetchall()} == {p.place_id for p in expected}


def test_default_budget_is_25_dollars(monkeypatch):
    assert budget_usd() == 25.0
    monkeypatch.setenv("ENRICH_BUDGET_USD", "40")
    assert budget_usd() == 40.0


def test_eval_enrich_exits_1_when_no_model_meets_the_targets(tmp_path, monkeypatch):
    use_fake(monkeypatch, FakeAnthropic())  # default responder: category only, "any"
    assert main(["--out", str(tmp_path / "out"), "eval-enrich", "--yes", "--limit", "40"]) == 1
