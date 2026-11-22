"""The Markdown run report (and a JSON twin that the next run uses as its baseline)."""

from __future__ import annotations

import logging
import os
from collections import Counter
from pathlib import Path
from typing import Any

from .cities import load_cities
from .layout import (
    checks_file,
    latest_json,
    read_json,
    report_json,
    report_md,
    stage_stats_file,
    staged_sources,
    write_json,
)
from .registry import Registry
from .settings import CONFIG_DIR
from .taxonomy import load_taxonomy

log = logging.getLogger(__name__)

STATUS_ICON = {"pass": "pass", "fail": "**FAIL**", "warn": "warn", "info": "info"}


def _pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def _cell(text: Any) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def build_report(
    out: Path, date: str, *, registry: Registry, config_dir: Path = CONFIG_DIR
) -> tuple[str, dict[str, Any]]:
    sources = staged_sources(out, date)
    stats = {s: read_json(stage_stats_file(out, date, s)) for s in sources}
    checks = read_json(checks_file(out, date)) if checks_file(out, date).is_file() else None
    taxonomy = load_taxonomy(config_dir)
    city_names = {c.code: c.name for c in load_cities(config_dir=config_dir)}
    passed = bool(checks and checks["passed"])

    lines = [f"# Trippr data pipeline run {date}", ""]
    if checks is None:
        lines += ["Checks: **not run**", ""]
    else:
        lines += [f"Checks: **{'passed' if passed else 'FAILED'}**", ""]
        if checks.get("baseline_run_date"):
            lines += [f"Row counts compared with the run of {checks['baseline_run_date']}.", ""]

    lines += [
        "## Sources",
        "",
        "| Source | Version | Raw rows | Staged rows | Excluded share | Unmapped share | Licence |",
        "|---|---|---:|---:|---:|---:|---|",
    ]
    for s, st in stats.items():
        lines.append(
            f"| {registry.sources[s].name if s in registry.sources else s} | {st['version']} | {st['raw_rows']:,} "
            f"| {st['staged_rows']:,} | {_pct(st['excluded_share'])} | {_pct(st['unmapped_share'])} | {st['licence']} |"
        )
    lines += [
        "",
        "Shares are of rows inside a Trippr city (after dropping duplicates and closed places). "
        "Excluded categories are dropped on purpose (offices, clinics, shops that are not trip activities); "
        "unmapped ones have no rule in the source's mapping CSV yet.",
        "",
    ]

    lines += [
        "## Dropped rows",
        "",
        "| Source | Duplicate ids | Closed | Outside every city | Country mismatch "
        "| Nearer another city | No name |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for s, st in stats.items():
        lines.append(
            f"| {s} | {st['duplicate_rows']:,} | {st['closed']:,} | {st['no_city']:,} | "
            f"{st['country_mismatch']:,} | {st['other_city']:,} | {st['no_name']:,} |"
        )
    lines.append("")

    all_cities = sorted({c for st in stats.values() for c in st["per_city"]})
    lines += [
        "## Staged places by city",
        "",
        "| City | " + " | ".join(stats) + " | Total |",
        "|---|" + "---:|" * (len(stats) + 1),
    ]
    for code in all_cities:
        counts = [st["per_city"].get(code, {}).get("staged_rows", 0) for st in stats.values()]
        lines.append(
            f"| {code} {city_names.get(code, '')} | "
            + " | ".join(f"{n:,}" for n in counts)
            + f" | {sum(counts):,} |"
        )
    lines.append("")

    by_tag: Counter[str] = Counter()
    by_cat: Counter[str] = Counter()
    for st in stats.values():
        for cat, n in st["by_category"].items():
            by_cat[cat] += n
            by_tag[taxonomy[cat].tag if cat in taxonomy else "?"] += n
    total = sum(by_tag.values()) or 1
    lines += ["## Colour tags", "", "| Tag | Places | Share |", "|---|---:|---:|"]
    lines += [f"| {tag} | {n:,} | {_pct(n / total)} |" for tag, n in by_tag.most_common()]
    lines += [
        "",
        "<details><summary>By Trippr category</summary>",
        "",
        "| Category | Tag | Places |",
        "|---|---|---:|",
    ]
    lines += [
        f"| {cat} | {taxonomy[cat].tag if cat in taxonomy else '?'} | {n:,} |"
        for cat, n in by_cat.most_common()
    ]
    lines += ["", "</details>", ""]

    lines += ["## Most common unmapped categories", ""]
    for s, st in stats.items():
        top = ", ".join(f"{_cell(u['category_source'])} ({u['rows']:,})" for u in st["unmapped_top"][:15])
        lines.append(f"- **{s}**: {top or 'none'}")
    lines.append("")

    if checks is not None:
        lines += ["## Checks", "", "| Check | Result | Detail |", "|---|---|---|"]
        lines += [
            f"| {r['name']} | {STATUS_ICON[r['status']]} | {_cell(r['detail'])} |" for r in checks["results"]
        ]
        lines.append("")

    lines += ["## Attribution", ""]
    lines += [
        f"- **{registry.sources[s].name}**: {registry.sources[s].attribution.strip()}"
        for s in stats
        if s in registry.sources
    ]
    lines.append("")
    markdown = "\n".join(lines)

    data = {
        "run_date": date,
        "passed": passed,
        "counts": checks["counts"] if checks else {},
        "sources": {s: {k: v for k, v in st.items() if k not in ("per_city",)} for s, st in stats.items()},
        "checks": checks["results"] if checks else [],
    }
    return markdown, data


def write_report(out: Path, date: str, *, registry: Registry, config_dir: Path = CONFIG_DIR) -> Path:
    markdown, data = build_report(out, date, registry=registry, config_dir=config_dir)
    path = report_md(out, date)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(markdown, encoding="utf-8", newline="\n")
    write_json(report_json(out, date), data)
    if data["passed"]:
        write_json(latest_json(out), data)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(markdown + "\n")
    log.info("report written to %s", path)
    return path
