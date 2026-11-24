"""A deterministic enrichment/<date>/enrichment.parquet for the bundle tests, written by the enrich stage's own
writer from a fake answer cache (no model, no network, nothing spent)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from trippr_data.enrich.inputs import read_places, taxonomy
from trippr_data.enrich.run import write_enrichment
from trippr_data.enrich.settings import enriched_file, eval_root
from trippr_data.layout import curated_file, write_json

MODEL = "claude-haiku-5-5"
ENRICHED_AT = "2026-11-18T09:30:00+00:00"

BEST_TIMES = ["morning", "afternoon", "evening", "night", "any"]
PRICES = ["free", "$", "$$", "$$$", None]


def answer(i: int, name: str, category: str, *, empty_summary: bool = False) -> dict:
    label = taxonomy()[category].label.lower()
    return {
        "value": {
            "tags": [category],
            "summary": "" if empty_summary else f"{name} is a {label}.",
            "duration_min": [30, 60, 90, 120, None][i % 5],
            "best_time": BEST_TIMES[i % 5],
            "indoor": [True, False, None][i % 3],
            "price_level": PRICES[i % 5],
            "good_for": [["rain"], ["views", "families"], [], ["nightlife"]][i % 4],
            "display_name": f"The {name}" if i % 7 == 0 else None,
            "is_generic_name": i % 7 == 0,
        },
        "model": MODEL,
        "prompt_version": "enrich-v1",
        "enriched_at": ENRICHED_AT,
        "batch_id": "msgbatch_fixture",
    }


def write_fixture_eval(out: Path) -> Path:
    """An eval-enrich report.json with made-up scores (a fixture, not a real run), so the bundle test and the
    app's Data page cover the scores path."""
    report = eval_root(out, MODEL) / "report.json"
    write_json(
        report,
        {
            "model": MODEL,
            "judge_model": None,
            "metrics": {
                "n": 174,
                "valid_rate": 1.0,
                "tag_f1": 0.8,
                "duration_within_tolerance": 0.7,
                "best_time_accuracy": 0.75,
                "indoor_accuracy": 0.85,
                "summary_rule_unsupported_rate": 0.04,
                "summary_judge_unsupported_rate": None,
                "display_name_match": 0.6,
            },
            "targets": {"tag_f1": True, "unsupported_summaries": True, "valid_answers": True},
            "by_script": {},
            "misses": [],
        },
    )
    return report


def write_fixture_enrichment(out: Path, date: str, *, every: int = 2) -> Path:
    """Enrich every `every`th curated place (the first one with an empty summary, to cover that case)."""
    places = sorted(read_places(curated_file(out, date)), key=lambda p: p.place_id)
    chosen = places[::every]
    cache = {
        p.content_hash(): answer(i, p.name_en or p.name, p.category, empty_summary=i == 0)
        for i, p in enumerate(chosen)
    }
    runner = SimpleNamespace(cache=cache, key_for=lambda content_hash: content_hash)
    path = enriched_file(out, date)
    write_enrichment(path, places, runner)  # type: ignore[arg-type]
    return path
