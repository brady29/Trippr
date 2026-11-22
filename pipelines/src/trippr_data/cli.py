"""Command line: python -m trippr_data <extract|stage|check|report|upload|run> [options]."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from . import checks as checks_mod
from .cities import load_cities, select_cities
from .extract import EXTRACTORS
from .extract.foursquare import FoursquareNotConfiguredError
from .layout import latest_raw_date, latest_staging_date
from .registry import Registry, SourceDisabledError, SourceNotRegisteredError, load_registry
from .report import write_report
from .settings import data_bucket, out_dir, today
from .stage import stage
from .storage import upload

log = logging.getLogger("trippr_data")


def _sources(spec: str | None, registry: Registry) -> list[str]:
    if not spec or spec == "enabled":
        return registry.enabled()
    names = [s.strip() for s in spec.split(",") if s.strip()]
    unknown = [s for s in names if s not in EXTRACTORS]
    if unknown:
        raise SystemExit(f"Unknown source(s): {', '.join(unknown)}. Known: {', '.join(EXTRACTORS)}")
    return names


def _date(args: argparse.Namespace, out: Path, kind: str) -> str:
    if args.date:
        return args.date
    found = latest_raw_date(out) if kind == "raw" else latest_staging_date(out)
    if not found:
        raise SystemExit(f"No {kind} data under {out}; run the earlier stage first or pass --date")
    return found


def _extract(args: argparse.Namespace, registry: Registry, out: Path) -> list[str]:
    """Extract each chosen source; returns the ones that ran. An enabled source that isn't configured
    (Foursquare without a Hugging Face token) is skipped with a warning when it wasn't asked for by name."""
    cities = select_cities(load_cities(), args.cities)
    date = args.date or today()
    named = bool(args.source and args.source != "enabled")
    done: list[str] = []
    for source in _sources(args.source, registry):
        kwargs = {"release": args.release} if source == "overture" and args.release else {}
        try:
            meta = EXTRACTORS[source](cities, out=out, date=date, registry=registry, **kwargs)
        except FoursquareNotConfiguredError as err:
            if named:
                raise SystemExit(str(err)) from err
            log.warning("skipping %s: %s", source, err)
            continue
        done.append(source)
        log.info(
            "%s %s: %s rows for %d cities", source, meta["version"], f"{meta['row_count']:,}", len(cities)
        )
    return done


def cmd_extract(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    _extract(args, registry, out)
    return 0


def cmd_stage(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    date = _date(args, out, "raw")
    sources = [s.strip() for s in args.source.split(",")] if args.source else None
    stage(out, date, registry=registry, sources=sources)
    return 0


def cmd_check(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    date = _date(args, out, "staging")
    passed, _ = checks_mod.check(out, date, registry=registry)
    return 0 if passed else 1


def cmd_report(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    date = _date(args, out, "staging")
    print(write_report(out, date, registry=registry))
    return 0


def cmd_upload(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    bucket = data_bucket()
    if not bucket:
        raise SystemExit("DATA_BUCKET is not set")
    upload(out, _date(args, out, "staging"), bucket)
    return 0


def cmd_run(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    """extract -> stage -> check -> report -> upload (when DATA_BUCKET is set). Fails if a check fails."""
    date = args.date or today()
    args.date = date
    extracted = _extract(args, registry, out)
    if not extracted:
        raise SystemExit("No source was extracted")
    stage(out, date, registry=registry, sources=extracted)
    passed, _ = checks_mod.check(out, date, registry=registry)
    print(write_report(out, date, registry=registry))
    bucket = data_bucket()
    if bucket and not args.no_upload:
        upload(out, date, bucket)
    elif not bucket:
        log.info("DATA_BUCKET not set; outputs stay in %s", out)
    return 0 if passed else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="trippr_data", description=__doc__)
    parser.add_argument("--out", type=Path, help="output root (default pipelines/out or $TRIPPR_DATA_OUT)")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name: str, fn, help_text: str) -> argparse.ArgumentParser:
        p = sub.add_parser(name, help=help_text)
        p.set_defaults(fn=fn)
        p.add_argument(
            "--date", help="run date folder, YYYY-MM-DD (default: today for extract/run, else latest)"
        )
        return p

    p = add("extract", cmd_extract, "read each city's bounding box from a source into raw/")
    p.add_argument("--source", help="overture, foursquare or a comma list (default: enabled sources)")
    p.add_argument("--cities", default="all", help="'all' or city codes, e.g. TYO,OSA")
    p.add_argument("--release", help="Overture release (default: latest from the STAC catalog)")

    p = add("stage", cmd_stage, "map raw rows onto staged_place in staging/")
    p.add_argument("--source", help="comma list (default: every source with raw data for the date)")

    add("check", cmd_check, "run the data quality checks; exits 1 on failure")
    add("report", cmd_report, "write the Markdown run report (and to $GITHUB_STEP_SUMMARY)")
    add("upload", cmd_upload, "copy the run to gs://$DATA_BUCKET")

    p = add("run", cmd_run, "extract, stage, check, report and upload")
    p.add_argument("--source", help="comma list (default: enabled sources)")
    p.add_argument("--cities", default="all", help="'all' or city codes")
    p.add_argument("--release", help="Overture release (default: latest)")
    p.add_argument("--no-upload", action="store_true", help="skip the upload even when DATA_BUCKET is set")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    out = args.out or out_dir()
    try:
        return args.fn(args, load_registry(), out)
    except (SourceNotRegisteredError, SourceDisabledError, FileNotFoundError, ValueError) as exc:
        log.error("%s", exc)
        return 2


if __name__ == "__main__":
    sys.exit(main())
