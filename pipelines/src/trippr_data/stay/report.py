"""The stay section of the run report (also written alone to reports/<date>.stay.md)."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from ..layout import read_json
from ..registry import Registry
from .layout import stay_checks_file, stay_report_md, stay_stats_file, stay_summary_file

log = logging.getLogger(__name__)

STATUS_ICON = {"pass": "pass", "fail": "**FAIL**", "warn": "warn", "info": "info"}


def _pct(x: float | None) -> str:
    return "n/a" if x is None else f"{100 * x:.0f}%"


def _cad(x: float | None) -> str:
    return "n/a" if x is None else f"{x:,.0f}"


def _cell(text: Any) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def _load(path: Path) -> Any | None:
    return read_json(path) if path.is_file() else None


def stay_section(out: Path, date: str, registry: Registry, *, level: str = "##") -> list[str]:
    """Markdown lines for the stay tables of one run; empty when no stay stage ran for the date."""
    airbnb = _load(stay_stats_file(out, date, "airbnb"))
    hotel = _load(stay_stats_file(out, date, "hotel"))
    summary = _load(stay_summary_file(out, date))
    checks = _load(stay_checks_file(out, date))
    if not (airbnb or hotel or summary):
        return []
    sub = level + "#"
    lines = [f"{level} Stay analytics", ""]
    if checks is not None:
        lines += [f"Stay checks: **{'passed' if checks['passed'] else 'FAILED'}**", ""]
    if summary:
        cov = summary["coverage"]
        lines += [
            f"Inside Airbnb has data for {len(cov['inside_airbnb_cities'])} of Trippr's {cov['trippr_cities']} cities "
            f"({', '.join(cov['inside_airbnb_cities'])}); the other {cov['no_inside_airbnb']} cities have no market layer. "
            f"{summary['scored_units']:,} of {sum(summary['units'].values()):,} units have a stay score "
            f"(units: {', '.join(f'{k} {n:,}' for k, n in summary['units'].items())}). "
            f"Score weights: {', '.join(f'{k} {v:.0%}' for k, v in summary['weights'].items())}.",
            "",
        ]

    if airbnb:
        lines += [
            f"{sub} Inside Airbnb",
            "",
            "| City | Snapshot | Currency | CAD per unit | Listings | Inside city radius | No price | Outliers dropped | Long-stay (min nights) "
            "| Used for prices | Median CAD/night | Reviews, last 12 months |",
            "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
        for code, c in airbnb["per_city"].items():
            lines.append(
                f"| {code} | {c['snapshot']} | {c['currency']} | {c['cad_per_unit']:g} ({c['rate_date']}) | {c['listings']:,} "
                f"| {c['in_radius']:,} | {c['price_missing']:,} | {c['below_floor'] + c['above_p99']:,} "
                f"| {c['long_stay']:,} | {c['stats_ok']:,} | {_cad(c['median_price_cad'])} | {c['reviews_ltm']:,} |"
            )
        lines += [
            "",
            f"Prices are in each city's local currency and converted at the Bank of Canada rate on or before the snapshot date. "
            f"Dropped as outliers: below CAD {airbnb['price_floor_cad']:g}, or above the city's "
            f"{airbnb['outlier_percentile']:.0%} percentile. Long-stay means a minimum stay over {airbnb['max_min_nights']} nights "
            f"(left out of price statistics).",
            "",
        ]

    if summary and summary["cities"]:
        lines += [
            f"{sub} Headline numbers by city",
            "",
            "| City | Median CAD/night | Entire home | Private room | Median CAD per person | Entire-home share "
            "| Rating | Unavailable next year | Multi-listing hosts | Hotels (open data) | Areas | Neighbourhoods | H3 cells |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
        for code, c in summary["cities"].items():
            lines.append(
                f"| {code} {c['name']} | {_cad(c['median_price_cad'])} | {_cad(c['median_price_entire_cad'])} "
                f"| {_cad(c['median_price_private_cad'])} | {_cad(c['median_price_pp_cad'])} "
                f"| {_pct(c['entire_home_share'])} | {c['median_rating'] if c['median_rating'] is not None else 'n/a'} "
                f"| {_pct(c['unavailable_share'])} | {_pct(c['multi_host_share'])} | {c['n_hotels'] if c['n_hotels'] is not None else 'n/a'} "
                f"| {c['areas']} | {c['neighbourhoods']} | {c['h3_cells']:,} |"
            )
        lines.append("")
        for code, c in summary["cities"].items():
            if c["top_neighbourhoods"]:
                best = ", ".join(
                    f"{_cell(n['name'])} ({n['stay_score']}, CAD {_cad(n['median_price_cad'])})" for n in c["top_neighbourhoods"]
                )
                lines.append(f"- **{code}** best-scoring neighbourhoods: {best}")
        lines.append("")

    if hotel:
        lines += [
            f"{sub} Hotels from open data",
            "",
            "| Source | Version | Lodging rows | Closed | Outside cities | Excluded kind | No name | Staged | Kind other |",
            "|---|---|---:|---:|---:|---:|---:|---:|---:|",
        ]
        for s, st in hotel["sources"].items():
            lines.append(
                f"| {s} | {st['version']} | {st['raw_lodging_rows']:,} | {st['closed']:,} | {st['no_city'] + st['country_mismatch']:,} "
                f"| {st['excluded_kind']:,} | {st['no_name']:,} | {st['staged_rows']:,} | {st['other_kind']:,} |"
            )
        m = hotel["merge"]
        lines += [
            "",
            f"{hotel['hotels']:,} hotels after merging {m['records']:,} source records ({hotel['multi_source']:,} found in more than one source; "
            f"{m['accepted_pairs']:,} merged pairs). {hotel['with_area']:,} fall in a Trippr Area, {hotel['with_stars']:,} have a star rating, "
            f"{hotel['with_website']:,} have a website. Kinds: {', '.join(f'{k} {n:,}' for k, n in hotel['by_kind'].items())}.",
            "",
        ]
        if hotel["areas_without_centre"]:
            lines += [f"{len(hotel['areas_without_centre'])} seeded Areas have no coordinates yet and cannot be scored.", ""]

    if checks:
        lines += [f"{sub} Stay checks", "", "| Check | Result | Detail |", "|---|---|---|"]
        lines += [f"| {r['name']} | {STATUS_ICON[r['status']]} | {_cell(r['detail'])} |" for r in checks["results"]]
        lines.append("")

    lines += [f"{sub} Stay attribution", ""]
    for key in ("insideairbnb", "boc_fx", "osm_lodging"):
        entry = registry.sources.get(key)
        if entry and ((key == "insideairbnb" and airbnb) or (key == "boc_fx" and airbnb) or (key == "osm_lodging" and hotel and "osm_lodging" in hotel["sources"])):
            lines.append(f"- **{entry.name}**: {entry.attribution.strip()}")
    lines.append("")
    return lines


def write_stay_report(out: Path, date: str, *, registry: Registry) -> Path:
    lines = stay_section(out, date, registry, level="#")
    if not lines:
        raise FileNotFoundError(f"No stay results for {date} under {out}; run stay-stage and stay-analyse first")
    target = stay_report_md(out, date)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    log.info("stay report written to %s", target)
    return target
