"""Where the stay stages read and write. Staged stay tables sit in a stay/ folder under staging/<date>/
(the existing staged_place tooling only looks at the Parquet files directly in staging/<date>/), and the
analytics output goes to curated/<date>/stay/."""

from __future__ import annotations

from pathlib import Path

from ..layout import reports_dir, staging_dir

STAGED_TABLES = (
    "hotel",
    "hotel_source",
    "airbnb_listing",
    "airbnb_calendar",
    "airbnb_reviews_monthly",
    "airbnb_neighbourhood",
)
CURATED_TABLES = ("stay_unit",)


def stay_staging_dir(out: Path, date: str) -> Path:
    return staging_dir(out, date) / "stay"


def stay_table(out: Path, date: str, name: str) -> Path:
    base = stay_staging_dir(out, date) if name in STAGED_TABLES else curated_stay_dir(out, date)
    return base / f"{name}.parquet"


def stay_stats_file(out: Path, date: str, name: str) -> Path:
    return stay_staging_dir(out, date) / f"{name}.stats.json"


def curated_stay_dir(out: Path, date: str) -> Path:
    return out / "curated" / date / "stay"


def stay_summary_file(out: Path, date: str) -> Path:
    return curated_stay_dir(out, date) / "stay_summary.json"


def stay_checks_file(out: Path, date: str) -> Path:
    return reports_dir(out) / f"{date}.stay.checks.json"


def stay_report_md(out: Path, date: str) -> Path:
    return reports_dir(out) / f"{date}.stay.md"
