"""The `embed` and `eval-search` commands. cli.py registers them with `register(sub)`."""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

from ..layout import dated_dirs, read_json
from ..registry import Registry
from ..settings import PIPELINE_ROOT, today
from .embedders import available_models, make_embedder
from .evaluate import render_markdown, run_eval_search
from .inputs import curated_places_path
from .run import MANIFEST_FILE, embeddings_dir, latest_embeddings_date, run_embed

log = logging.getLogger(__name__)

DEFAULT_MODEL = "multilingual-e5-small"
EVAL_DIR = PIPELINE_ROOT / "eval" / "search"


def cmd_embed(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    curated = dated_dirs(out / "curated")
    if args.input:
        input_path: str | Path = args.input
    elif curated:
        input_path = curated_places_path(out, args.date or curated[-1])
    else:
        raise SystemExit(f"No curated places under {out / 'curated'}; pass --input (Parquet or CSV)")
    date = args.date or (curated[-1] if curated and not args.input else today())
    embedder = make_embedder(args.model, threads=args.threads)
    result = run_embed(
        input_path,
        embedder,
        out,
        date,
        city=args.city,
        limit=args.limit,
        batch_size=args.batch_size,
        use_cache=not args.no_cache,
    )
    print(json.dumps(result.manifest, ensure_ascii=False, indent=2))
    return 0


def cmd_eval_search(args: argparse.Namespace, registry: Registry, out: Path) -> int:
    date = args.date or latest_embeddings_date(out)
    if not date:
        raise SystemExit(f"No embeddings under {out / 'embeddings'}; run `embed` first or pass --date")
    directory = embeddings_dir(out, date)
    manifest = read_json(directory / MANIFEST_FILE)
    embedder = make_embedder(manifest["model"], threads=args.threads)
    passed, result = run_eval_search(
        directory,
        Path(args.queries),
        args.corpus,
        embedder,
        out,
        date,
        min_mrr=args.min_mrr,
        min_recall10=args.min_recall10,
    )
    print(render_markdown(result, manifest["model"]))
    for failure in result["failures"]:
        log.error("search eval failed: %s", failure)
    return 0 if passed else 1


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser("embed", help="embed curated places into vectors (cached by content hash)")
    p.set_defaults(fn=cmd_embed)
    p.add_argument("--date", help="run folder, YYYY-MM-DD (default: the newest curated run, else today)")
    p.add_argument("--input", help="places Parquet/CSV or glob (default: curated/<date>/places.parquet)")
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"one of: {', '.join(available_models())}")
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--threads", type=int, help="cap CPU threads (default: all)")
    p.add_argument("--city", help="only this city (code or name, whichever the input has)")
    p.add_argument("--limit", type=int, help="only the first N places by id (for trials)")
    p.add_argument("--no-cache", action="store_true", help="ignore and do not update the vector cache")

    p = sub.add_parser("eval-search", help="search relevance (recall@k, MRR, NDCG) on the labelled queries")
    p.set_defaults(fn=cmd_eval_search)
    p.add_argument("--date", help="embeddings run folder (default: the newest)")
    p.add_argument("--queries", default=str(EVAL_DIR / "queries.yaml"))
    p.add_argument("--corpus", default=str(EVAL_DIR / "places.csv"), help="places the labels refer to")
    p.add_argument("--threads", type=int)
    p.add_argument("--min-mrr", type=float, help="exit 1 below this MRR")
    p.add_argument("--min-recall10", type=float, help="exit 1 below this recall@10")
