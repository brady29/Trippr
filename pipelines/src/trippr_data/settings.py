"""Paths and environment settings shared by every stage."""

from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path

PIPELINE_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = PIPELINE_ROOT.parent
CONFIG_DIR = PIPELINE_ROOT / "config"
SEED_DIR = REPO_ROOT / "seed"
REGISTRY_PATH = PIPELINE_ROOT / "sources.yaml"

DEFAULT_CITY_RADIUS_KM = 25.0
SMALL_PLACE_RADIUS_KM = 10.0


def out_dir() -> Path:
    """Local output root, laid out like the bucket (raw/, staging/, reports/)."""
    return Path(os.environ.get("TRIPPR_DATA_OUT") or PIPELINE_ROOT / "out")


def city_radius_default_km() -> float:
    value = os.environ.get("CITY_RADIUS_DEFAULT_KM")
    return float(value) if value else DEFAULT_CITY_RADIUS_KM


def data_bucket() -> str | None:
    value = (os.environ.get("DATA_BUCKET") or "").strip()
    if value.startswith("gs://"):
        value = value[len("gs://") :]
    return value.rstrip("/") or None


def today() -> str:
    return datetime.now(UTC).date().isoformat()


def utc_now() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)
