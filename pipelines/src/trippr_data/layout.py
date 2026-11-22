"""Where each file lives. The local out/ directory mirrors the bucket layout."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def raw_dir(out: Path, source: str, date: str) -> Path:
    return out / "raw" / source / date


def staging_dir(out: Path, date: str) -> Path:
    return out / "staging" / date


def staged_file(out: Path, date: str, source: str) -> Path:
    return staging_dir(out, date) / f"{source}.parquet"


def stage_stats_file(out: Path, date: str, source: str) -> Path:
    return staging_dir(out, date) / f"{source}.stats.json"


def reports_dir(out: Path) -> Path:
    return out / "reports"


def checks_file(out: Path, date: str) -> Path:
    return reports_dir(out) / f"{date}.checks.json"


def report_md(out: Path, date: str) -> Path:
    return reports_dir(out) / f"{date}.md"


def report_json(out: Path, date: str) -> Path:
    return reports_dir(out) / f"{date}.json"


def latest_json(out: Path) -> Path:
    return reports_dir(out) / "latest.json"


def dated_dirs(parent: Path) -> list[str]:
    if not parent.is_dir():
        return []
    return sorted(p.name for p in parent.iterdir() if p.is_dir() and DATE_RE.match(p.name))


def latest_raw_date(out: Path) -> str | None:
    dates = {d for source_dir in (out / "raw").glob("*") for d in dated_dirs(source_dir)}
    return max(dates) if dates else None


def latest_staging_date(out: Path) -> str | None:
    dates = dated_dirs(out / "staging")
    return dates[-1] if dates else None


def raw_sources(out: Path, date: str) -> list[str]:
    root = out / "raw"
    if not root.is_dir():
        return []
    return sorted(p.name for p in root.iterdir() if (p / date / "_meta.json").is_file())


def staged_sources(out: Path, date: str) -> list[str]:
    return sorted(p.stem for p in staging_dir(out, date).glob("*.parquet"))


def read_json(path: Path) -> Any:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=False, default=str)
        fh.write("\n")
    tmp.replace(path)
