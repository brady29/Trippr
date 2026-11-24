"""Enrichment settings (environment) and where its files live under the output root."""

from __future__ import annotations

import os
from pathlib import Path

DEFAULT_MODEL = "claude-haiku-5-5"
DEFAULT_BUDGET_USD = 10.0
DEFAULT_EFFORT = "low"

# Model aliases accepted on the command line.
MODEL_ALIASES = {"haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5"}


def resolve_model(name: str) -> str:
    return MODEL_ALIASES.get(name.strip().lower(), name.strip())


def budget_usd() -> float:
    """ENRICH_BUDGET_USD (spec default 10): the most one enrich run may be estimated to cost."""
    raw = (os.environ.get("ENRICH_BUDGET_USD") or "").strip()
    return float(raw) if raw else DEFAULT_BUDGET_USD


def default_model() -> str:
    return resolve_model(os.environ.get("ENRICH_MODEL") or DEFAULT_MODEL)


def enrich_root(out: Path) -> Path:
    """State and cache of the production enrichment (cached across dates; not a dated folder)."""
    return out / "enrich"


def eval_root(out: Path, model: str) -> Path:
    """State and cache of eval runs, kept apart from production, one folder per model."""
    return out / "enrich-eval" / model


def enriched_file(out: Path, date: str) -> Path:
    return out / "enriched" / date / "enrichment.parquet"
