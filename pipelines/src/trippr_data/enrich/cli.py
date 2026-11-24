"""Commands: enrich, enrich-status and eval-enrich (registered on the main CLI by trippr_data.cli)."""

from __future__ import annotations

import argparse
import logging
from pathlib import Path
from typing import Any

from ..layout import latest_curated_date, write_json
from ..registry import Registry
from ..settings import today
from . import client as client_mod
from .batches import DEFAULT_BATCH_SIZE, DEFAULT_POLL_SECONDS
from .estimate import DEFAULT_OUTPUT_TOKENS, BudgetExceededError
from .evaluate import (
    DURATION_TOLERANCE_MIN,
    EVAL_SET_PATH,
    EvalReport,
    load_eval_set,
    render_comparison,
    render_report,
    run_eval,
)
from .inputs import default_input, parse_column_map, read_places
from .run import ConfirmationRequiredError, enrich_places, make_runner
from .settings import (
    DEFAULT_EFFORT,
    budget_usd,
    default_model,
    enrich_root,
    enriched_file,
    eval_root,
    resolve_model,
)

log = logging.getLogger("trippr_data.enrich")

EXIT_REFUSED = 3  # over the cap, or spending without --yes
EXIT_NO_KEY = 4


def _client(args: argparse.Namespace) -> Any | None:
    """No client for --dry-run --offline (the estimate then uses a character heuristic)."""
    if getattr(args, "offline", False):
        if not getattr(args, "dry_run", False):
            raise ValueError("--offline only makes sense with --dry-run")
        return None
    return client_mod.make_client()


def _guard(fn):
    def wrapper(args: argparse.Namespace, registry: Registry, out: Path) -> int:
        try:
            return fn(args, registry, out)
        except BudgetExceededError as err:
            log.error("%s", err)
            return EXIT_REFUSED
        except ConfirmationRequiredError as err:
            log.error("%s", err)
            return EXIT_REFUSED
        except client_mod.MissingApiKeyError as err:
            log.error("%s", err)
            return EXIT_NO_KEY

    return wrapper


@_guard
def cmd_enrich(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    date = args.date or latest_curated_date(out) or today()
    model = resolve_model(args.model) if args.model else default_model()
    cap = args.budget_usd if args.budget_usd is not None else budget_usd()
    path = args.input or default_input(out, args.date)
    places = read_places(Path(path), parse_column_map(args.column_map))
    if args.limit:
        places = places[: args.limit]
    if args.extrapolate_to and not args.dry_run:
        raise ValueError("--extrapolate-to only makes sense with --dry-run")
    result = enrich_places(
        _client(args),
        places,
        enrich_root(out),
        model=model,
        effort=args.effort,
        budget_usd=cap,
        dry_run=args.dry_run,
        yes=args.yes,
        wait=not args.no_wait,
        batch_size=args.batch_size,
        poll_seconds=args.poll_seconds,
        output_tokens=args.output_tokens,
        extrapolate_to=args.extrapolate_to,
        output=None if args.dry_run else enriched_file(out, date),
    )
    if args.dry_run:
        print("Dry run: nothing was submitted and nothing was spent.")
        return 0
    c = result.collected
    if c.batches:
        print(
            f"Collected {c.batches} batch(es): {c.succeeded} ok, {c.failed} failed, ${c.actual_usd:.4f} actual."
        )
    for line in c.errors[:5]:
        print(f"  failed: {line}")
    if result.output:
        print(
            f"Wrote {result.n_enriched:,} enriched places to {result.output} ({result.n_missing:,} without an answer yet)."
        )
    if result.n_missing and args.no_wait:
        print(
            "Batches are still running; rerun the same command later to collect them (nothing is paid twice)."
        )
    return 0


@_guard
def cmd_status(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    model = resolve_model(args.model) if args.model else default_model()
    runner = make_runner(client_mod.make_client() if args.collect else None, enrich_root(out), model)
    if args.collect:
        summary = runner.collect_ready()
        print(
            f"Collected {summary.batches} finished batch(es): {summary.succeeded} ok, {summary.failed} failed."
        )
    batches = runner.status()
    print(f"{len(runner.cache):,} answers cached; {len(runner.state.data['failures']):,} keys with failures.")
    for b in batches:
        actual = f"${b['actual_usd']:.4f}" if b.get("actual_usd") is not None else "pending"
        print(
            f"  {b['batch_id']}  {b['status']:<12} {b['n']:>6} requests  est ${b['est_usd']:.2f}  actual {actual}  {b['model']}"
        )
    return 0


@_guard
def cmd_eval(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    names = args.models or args.model
    models = [resolve_model(m) for m in names.split(",")] if names else [default_model()]
    cap = args.budget_usd if args.budget_usd is not None else budget_usd()
    items = load_eval_set(Path(args.eval_set))
    if args.limit:
        items = items[: args.limit]
    judge_model = resolve_model(args.judge_model) if args.judge else None
    client = _client(args)
    reports: list[EvalReport] = []
    for model in models:
        root = eval_root(out, model)
        rep = run_eval(
            client,
            items,
            root,
            model=model,
            effort=args.effort,
            budget_usd=cap,
            judge_model=judge_model,
            dry_run=args.dry_run,
            yes=args.yes,
            tolerance=args.tolerance,
            batch_size=args.batch_size,
            poll_seconds=args.poll_seconds,
            output_tokens=args.output_tokens,
            extrapolate_to=args.extrapolate_to,
        )
        if args.dry_run:
            continue
        write_json(root / "report.json", rep.as_dict())
        (root / "report.md").write_text(render_report(rep, args.tolerance), encoding="utf-8", newline="\n")
        print(render_report(rep, args.tolerance))
        reports.append(rep)
    if args.dry_run:
        print("Dry run: nothing was submitted and nothing was spent.")
        return 0
    if len(reports) > 1:
        print(render_comparison(reports))
    return 0 if any(r.meets_targets for r in reports) else 1


def _common(p: argparse.ArgumentParser, *, cap_help: str) -> None:
    p.add_argument("--model", help="haiku, sonnet or a model id (default: ENRICH_MODEL or claude-haiku-5-5)")
    p.add_argument(
        "--effort", default=DEFAULT_EFFORT, choices=["low", "medium", "high"], help="thinking effort"
    )
    p.add_argument("--budget-usd", type=float, help=cap_help)
    p.add_argument("--dry-run", action="store_true", help="estimate tokens and cost, submit nothing")
    p.add_argument(
        "--offline", action="store_true", help="with --dry-run: no API call; estimate by character count"
    )
    p.add_argument("--yes", action="store_true", help="allow spending (without it nothing is submitted)")
    p.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    p.add_argument("--poll-seconds", type=float, default=DEFAULT_POLL_SECONDS)
    p.add_argument(
        "--output-tokens", type=int, default=DEFAULT_OUTPUT_TOKENS, help="assumed output tokens per place"
    )
    p.add_argument("--limit", type=int, help="only the first N places")
    p.add_argument(
        "--extrapolate-to", type=int, help="with --dry-run: scale the estimate to this many places"
    )


def register(sub: Any) -> None:
    """Add the enrichment commands to the main parser's subparsers."""
    p = sub.add_parser(
        "enrich", help="LLM enrichment through the Batch API (tags, summary, duration, best time)"
    )
    p.set_defaults(fn=cmd_enrich)
    p.add_argument("--date", help="run date folder, YYYY-MM-DD (default: the newest curated run)")
    p.add_argument(
        "--input",
        help="curated places: Parquet or JSON lines (default: the newest out/curated/<date>/curated_place.parquet)",
    )
    p.add_argument(
        "--column-map",
        nargs="*",
        metavar="OURS=THEIRS",
        help="input column names that differ, e.g. place_id=golden_id",
    )
    p.add_argument("--no-wait", action="store_true", help="submit and return; rerun later to collect")
    _common(p, cap_help="spend cap in USD for this run (default: ENRICH_BUDGET_USD, else 25)")

    p = sub.add_parser("enrich-status", help="show submitted batches; --collect fetches the finished ones")
    p.set_defaults(fn=cmd_status)
    p.add_argument("--model")
    p.add_argument("--collect", action="store_true", help="collect finished batches into the cache")

    p = sub.add_parser(
        "eval-enrich", help="score a model on the labelled places (tag F1, duration, best time, faithfulness)"
    )
    p.set_defaults(fn=cmd_eval)
    p.add_argument("--eval-set", default=str(EVAL_SET_PATH))
    p.add_argument("--models", help="comma list to compare, e.g. haiku,sonnet (default: one model)")
    p.add_argument(
        "--judge", action="store_true", help="also check summaries with an LLM judge (a second batch)"
    )
    p.add_argument("--judge-model", default="haiku")
    p.add_argument(
        "--tolerance", type=int, default=DURATION_TOLERANCE_MIN, help="minutes for the duration metric"
    )
    _common(p, cap_help="spend cap in USD per step (default: ENRICH_BUDGET_USD, else 25)")


__all__ = ["register"]
