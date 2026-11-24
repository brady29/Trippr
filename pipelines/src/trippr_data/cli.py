"""Command line: python -m trippr_data <extract|stage|match|sample-er|eval-er|check|report|curate|bundle|enrich|eval-enrich|upload|run> [options]."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from . import checks as checks_mod
from .bundle import append_bundle_report, build_bundle
from .cities import load_cities, select_cities
from .curation import curate, default_date
from .embed.cli import register as register_embed
from .enrich.cli import register as register_enrich
from .eval_er import EVAL_CITIES, evaluate, format_eval, sample_pairs
from .extract import EXTRACTORS
from .extract.foursquare import FoursquareNotConfiguredError
from .layout import latest_curated_date, latest_raw_date, latest_staging_date
from .match import MatchConfig, match
from .registry import Registry, SourceDisabledError, SourceNotRegisteredError, load_registry
from .report import write_report
from .settings import PIPELINE_ROOT, data_bucket, out_dir, today
from .stage import stage
from .stay.runner import add_commands as stay_commands
from .storage import upload

log = logging.getLogger("trippr_data")

ER_LABELS = PIPELINE_ROOT / "eval" / "er_pairs.csv"


def _sources(spec: str | None, registry: Registry) -> list[str]:
    if not spec or spec == "enabled":
        names = [s for s in registry.enabled() if s in EXTRACTORS]  # stay sources have their own commands
    else:
        names = [s.strip() for s in spec.split(",") if s.strip()]
        unknown = [s for s in names if s not in EXTRACTORS]
        if unknown:
            raise SystemExit(f"Unknown source(s): {', '.join(unknown)}. Known: {', '.join(EXTRACTORS)}")
    return sorted(names, key=lambda n: list(EXTRACTORS).index(n) if n in EXTRACTORS else len(EXTRACTORS))


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


def _match_config(args: argparse.Namespace) -> MatchConfig:
    return MatchConfig(threshold=args.threshold) if getattr(args, "threshold", None) else MatchConfig()


def cmd_match(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    match(out, _date(args, out, "staging"), registry=registry, cfg=_match_config(args))
    return 0


def cmd_sample_er(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    cities = tuple(c.strip().upper() for c in args.cities.split(",")) if args.cities else EVAL_CITIES
    n = sample_pairs(out, _date(args, out, "staging"), args.labels, cities=cities, per_city=args.per_city)
    print(
        f"wrote {n} candidate pairs to {args.labels}; fill in the label column (1 same place, 0 different, ? unsure)"
    )
    return 0


def cmd_eval_er(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    result = evaluate(out, _date(args, out, "staging"), args.labels, cfg=_match_config(args))
    print(format_eval(result))
    return 0 if result["meets_targets"] or not args.strict else 1


def cmd_check(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    date = _date(args, out, "staging")
    passed, _ = checks_mod.check(out, date, registry=registry)
    return 0 if passed else 1


def cmd_report(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    date = _date(args, out, "staging")
    print(write_report(out, date, registry=registry))
    return 0


def cmd_curate(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    date = args.date or default_date(out)
    if not date:
        raise SystemExit(f"No matched data under {out}; run match first or pass --date")
    curate(out, date)
    return 0


def cmd_bundle(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    date = args.date or latest_curated_date(out)
    if not date:
        raise SystemExit(f"No curated data under {out}; run curate first or pass --date")
    path, manifest = build_bundle(out, date, registry=registry, parquet=not args.no_parquet)
    append_bundle_report(out, date, manifest)
    print(path)
    return 0 if manifest.checks.passed else 1


def cmd_upload(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    bucket = data_bucket()
    if not bucket:
        raise SystemExit("DATA_BUCKET is not set")
    upload(out, _date(args, out, "staging"), bucket)
    return 0


def cmd_run(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    """extract -> stage -> match -> eval -> check -> report -> upload (when DATA_BUCKET is set). Fails if a check fails."""
    date = args.date or today()
    args.date = date
    extracted = _extract(args, registry, out)
    if not extracted:
        raise SystemExit("No source was extracted")
    stage(out, date, registry=registry, sources=extracted)
    match(out, date, registry=registry)
    if ER_LABELS.is_file():
        evaluate(out, date, ER_LABELS)
    else:
        log.warning("no labelled pairs at %s; skipping the entity-resolution eval", ER_LABELS)
    passed, _ = checks_mod.check(out, date, registry=registry)
    print(write_report(out, date, registry=registry))
    if passed and not args.no_bundle:
        curate(out, date)
        _, manifest = build_bundle(out, date, registry=registry)
        append_bundle_report(out, date, manifest)
        passed = manifest.checks.passed
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
    p.add_argument(
        "--source",
        help="overture, foursquare, osm, wikidata, wikivoyage or a comma list (default: enabled sources)",
    )
    p.add_argument("--cities", default="all", help="'all' or city codes, e.g. TYO,OSA")
    p.add_argument("--release", help="Overture release (default: latest from the STAC catalog)")

    p = add("stage", cmd_stage, "map raw rows onto staged_place in staging/")
    p.add_argument("--source", help="comma list (default: every source with raw data for the date)")

    p = add("match", cmd_match, "entity resolution: links.parquet and golden.parquet in matched/")
    p.add_argument("--threshold", type=float, help="score needed to accept a pair (default 0.82)")

    p = add("sample-er", cmd_sample_er, "sample candidate pairs into a labelling CSV")
    p.add_argument("--labels", type=Path, default=ER_LABELS, help="CSV to write (default eval/er_pairs.csv)")
    p.add_argument("--cities", help=f"comma list (default {','.join(EVAL_CITIES)})")
    p.add_argument("--per-city", type=int, default=68)

    p = add("eval-er", cmd_eval_er, "precision and recall of the matcher on the labelled pairs")
    p.add_argument("--labels", type=Path, default=ER_LABELS)
    p.add_argument("--threshold", type=float, help="score needed to accept a pair (default 0.82)")
    p.add_argument("--strict", action="store_true", help="exit 1 when the 95% / 85% targets are not met")

    add("check", cmd_check, "run the data quality checks; exits 1 on failure")
    add("report", cmd_report, "write the Markdown run report (and to $GITHUB_STEP_SUMMARY)")
    add("curate", cmd_curate, "rank golden records and choose the places for the graph (curated/)")
    p = add("bundle", cmd_bundle, "write bundles/<date>/ from the curated places; exits 1 if a check fails")
    p.add_argument("--no-parquet", action="store_true", help="leave places.parquet out of the bundle")
    add("upload", cmd_upload, "copy the run to gs://$DATA_BUCKET")

    p = add("run", cmd_run, "extract, stage, check, report and upload")
    p.add_argument("--source", help="comma list (default: enabled sources)")
    p.add_argument("--cities", default="all", help="'all' or city codes")
    p.add_argument("--release", help="Overture release (default: latest)")
    p.add_argument("--no-upload", action="store_true", help="skip the upload even when DATA_BUCKET is set")
    p.add_argument(
        "--no-bundle", action="store_true", help="stop after the checks and report (no curate or bundle)"
    )

    register_enrich(sub)  # enrich, enrich-status, eval-enrich
    register_embed(sub)
    stay_commands(add)
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
