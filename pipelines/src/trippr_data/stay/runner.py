"""Command line wiring for the stay stages (registered from cli.py):

    stay-extract  download Inside Airbnb snapshots (+ Bank of Canada rates) and, optionally, OSM lodging
    stay-stage    stage hotels and Inside Airbnb listings into staging/<date>/stay/
    stay-analyse  aggregate by Area, neighbourhood and H3 cell, compute the stay scores
    stay-check    data quality checks for the stay tables; exits 1 on a failure
    stay-report   write the stay report section (reports/<date>.stay.md)
    stay          stage, analyse, check and report from the raw data already extracted
"""

from __future__ import annotations

import argparse
import logging
from collections.abc import Callable
from pathlib import Path

from ..cities import load_cities, select_cities
from ..layout import latest_raw_date, raw_dir, read_json
from ..registry import Registry
from ..settings import today

log = logging.getLogger("trippr_data")

EXTRACT_SOURCES = ("insideairbnb", "osm_lodging")


def _date(args: argparse.Namespace, out: Path) -> str:
    if args.date:
        return args.date
    for source in ("insideairbnb", "overture", "osm_lodging"):
        dates = sorted(p.name for p in (out / "raw" / source).glob("*") if (p / "_meta.json").is_file())
        if dates:
            return dates[-1]
    found = latest_raw_date(out)
    if not found:
        raise SystemExit(f"No raw data under {out}; run stay-extract first or pass --date")
    return found


def cmd_stay_extract(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    from ..extract import boc_fx, insideairbnb, osm_lodging
    from ..extract.polite_http import PoliteClient

    date = args.date or today()
    cities = select_cities(load_cities(), args.cities)
    wanted = list(EXTRACT_SOURCES) if args.source == "all" else [s.strip() for s in args.source.split(",")]
    unknown = [s for s in wanted if s not in EXTRACT_SOURCES]
    if unknown:
        raise SystemExit(f"Unknown stay source(s) {unknown}. Known: {', '.join(EXTRACT_SOURCES)}")
    if "insideairbnb" in wanted:
        client = PoliteClient(min_interval_s=args.pause)
        meta = insideairbnb.extract(cities, out=out, date=date, registry=registry, client=client, force=args.force)
        log.info(
            "insideairbnb: %d covered cities %s; %d requests",
            len(meta["coverage"]["covered"]),
            meta["coverage"]["covered"],
            meta["requests"],
        )
        currencies, first, last = insideairbnb.fx_needs(meta, insideairbnb.load_city_map())
        if currencies:
            boc_fx.extract(currencies, first, last, out=out, date=date, registry=registry)
    if "osm_lodging" in wanted:
        osm_lodging.extract(cities, out=out, date=date, registry=registry, pause_s=args.osm_pause)
    return 0


def cmd_stay_stage(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    from . import airbnb, hotels

    date = _date(args, out)
    sources_present = {p.name for p in (out / "raw").glob("*") if (p / date / "_meta.json").is_file()}
    if sources_present & set(hotels.HOTEL_SOURCES):
        hotels.stage_hotels(out, date, registry=registry)
    else:
        log.warning("no overture, foursquare or osm_lodging raw data for %s; hotels not staged", date)
    if "insideairbnb" in sources_present:
        airbnb.stage_airbnb(out, date, registry=registry)
    else:
        log.warning("no insideairbnb raw data for %s; Inside Airbnb not staged", date)
    return 0


def cmd_stay_analyse(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    from . import analytics

    analytics.analyse(out, _date(args, out), places_date=args.places_date, places=args.places)
    return 0


def cmd_stay_check(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    from . import checks

    passed, _ = checks.check(out, _date(args, out), registry=registry)
    return 0 if passed else 1


def cmd_stay_report(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    from . import report

    print(report.write_stay_report(out, _date(args, out), registry=registry))
    return 0


def cmd_stay(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    from . import analytics, checks, report

    args.date = _date(args, out)
    cmd_stay_stage(args, registry, out)
    analytics.analyse(out, args.date, places_date=args.places_date, places=args.places)
    passed, _ = checks.check(out, args.date, registry=registry)
    print(report.write_stay_report(out, args.date, registry=registry))
    return 0 if passed else 1


def add_commands(add: Callable[[str, Callable, str], argparse.ArgumentParser]) -> None:
    """Register the stay commands on cli.py's parser (add is its local helper)."""
    p = add("stay-extract", cmd_stay_extract, "download Inside Airbnb (and optionally OSM lodging) into raw/")
    p.add_argument("--source", default="insideairbnb", help="insideairbnb, osm_lodging, a comma list or 'all'")
    p.add_argument("--cities", default="all", help="'all' or city codes (Inside Airbnb covers only some)")
    p.add_argument("--force", action="store_true", help="download snapshot files again even if already in raw/")
    p.add_argument("--pause", type=float, default=2.0, help="seconds between Inside Airbnb requests")
    p.add_argument("--osm-pause", type=float, default=10.0, help="seconds between Overpass queries")

    for name, fn, text in (
        ("stay-stage", cmd_stay_stage, "stage hotels and Inside Airbnb listings into staging/<date>/stay/"),
        ("stay-analyse", cmd_stay_analyse, "aggregate by Area, neighbourhood and H3 cell and score them"),
        ("stay-check", cmd_stay_check, "data quality checks for the stay tables; exits 1 on failure"),
        ("stay-report", cmd_stay_report, "write the stay report section"),
        ("stay", cmd_stay, "stage, analyse, check and report the stay tables"),
    ):
        p = add(name, fn, text)
        if name in ("stay-analyse", "stay"):
            p.add_argument("--places-date", help="date of the matched/staged places for walkability (default: --date)")
            p.add_argument(
                "--places",
                type=Path,
                help="a Parquet file or folder of places (city_code, lat, lon, category), e.g. a bundle's places.parquet",
            )


def raw_meta(out: Path, source: str, date: str) -> dict:
    return read_json(raw_dir(out, source, date) / "_meta.json")
