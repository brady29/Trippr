"""The embeddings spike (docs/embeddings-spike.md): one local model, measured.

    python eval/search/model_spike.py MODEL [--threads 4] [--corpus PARQUET --queries YAML]
    python eval/search/model_spike.py --all [--models A,B,...]   # each model in its own process

Each model runs in a fresh process so the memory numbers are its own. It embeds the labelled corpus,
runs the labelled queries against it with brute-force cosine and reports

- load_s, rss_after_load_mb: time and resident memory right after the model is loaded
- docs_per_s: throughput embedding the corpus with the pipeline's batch size
- peak_rss_mb: peak working set over the whole run (Windows) or max RSS (Linux)
- query_ms_p50 / p95: one query at a time, warm, which is what a query service does
- the metrics from `evaluate`: recall@k, success@k, MRR, NDCG@10, overall and by kind and language

The hybrid setup (places embedded on a laptop, queries embedded elsewhere) is tested with
`--save-vectors F` (keep the place vectors) and then `--doc-vectors F --model OTHER`: the queries are
embedded by OTHER and ranked against the saved vectors. When OTHER is a different build of the same
model (8-bit weights) this measures what the mismatch costs; when it is a different model the result
should collapse, which proves the point that both sides must be the same model.

Defaults are the small labelled set checked in beside this file (places.csv, queries.yaml). Models other
than `fake` and the ONNX ones need `pip install sentence-transformers` (spike only).
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parents[1] / "src"
sys.path.insert(0, str(SRC))

DEFAULT_MODELS = [
    "fake-384",
    "multilingual-e5-small",
    "multilingual-e5-small-q8",
    "st-multilingual-e5-small",
    "st-paraphrase-multilingual-MiniLM-L12-v2",
    "st-multilingual-e5-base",
    "st-bge-m3",
]


def rss_mb() -> tuple[float, float]:
    import psutil

    info = psutil.Process().memory_info()
    peak = getattr(info, "peak_wset", None) or getattr(info, "rss", 0)
    return info.rss / 2**20, peak / 2**20


def run_one(args: argparse.Namespace) -> dict:
    import numpy as np

    from trippr_data.embed.embedders import make_embedder
    from trippr_data.embed.evaluate import evaluate, load_queries
    from trippr_data.embed.inputs import read_places
    from trippr_data.embed.text import build_texts

    corpus = args.corpus or str(HERE / "places.csv")
    places = read_places(corpus)
    texts = build_texts(places)
    queries = load_queries(Path(args.queries or HERE / "queries.yaml"), corpus)

    base_rss, _ = rss_mb()
    t0 = time.perf_counter()
    embedder = make_embedder(args.model, threads=args.threads)
    embedder.embed_documents(["warm up"])  # first call builds kernels and buffers
    load_s = time.perf_counter() - t0
    after_load, _ = rss_mb()

    embed_s = None
    if args.doc_vectors:
        matrix = np.load(args.doc_vectors)
        if matrix.shape != (len(texts), embedder.dims):
            raise SystemExit(
                f"{args.doc_vectors} has shape {matrix.shape}, expected {(len(texts), embedder.dims)}"
            )
    else:
        t0 = time.perf_counter()
        chunks = [
            embedder.embed_documents(texts[i : i + args.batch_size])
            for i in range(0, len(texts), args.batch_size)
        ]
        embed_s = time.perf_counter() - t0
        matrix = np.concatenate(chunks)
        if args.save_vectors:
            np.save(args.save_vectors, matrix)

    latencies = []
    for i in range(args.query_reps):
        text = queries[i % len(queries)].text
        t0 = time.perf_counter()
        embedder.embed_queries([text])
        latencies.append((time.perf_counter() - t0) * 1000)

    result = evaluate(queries, embedder, [p.place_id for p in places], matrix)
    after_run, peak = rss_mb()
    return {
        "model": args.model,
        "docs_from": args.doc_vectors or args.model,
        "version": embedder.version,
        "dims": embedder.dims,
        "threads": args.threads,
        "corpus": len(texts),
        "queries": len(queries),
        "baseline_rss_mb": round(base_rss),
        "rss_after_load_mb": round(after_load),
        "rss_after_run_mb": round(after_run),
        "peak_rss_mb": round(peak),
        "load_s": round(load_s, 1),
        "docs_per_s": round(len(texts) / embed_s, 1) if embed_s else None,
        "embed_corpus_s": round(embed_s, 1) if embed_s else None,
        "query_ms_p50": round(statistics.median(latencies), 1),
        "query_ms_p95": round(sorted(latencies)[int(len(latencies) * 0.95) - 1], 1),
        "overall": result["overall"],
        "by_kind": result["by_kind"],
        "by_lang": result["by_lang"],
        "per_query": result["per_query"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("model", nargs="?")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--models", help="with --all: comma list instead of the default set")
    parser.add_argument("--threads", type=int)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--query-reps", type=int, default=60)
    parser.add_argument("--corpus", help="places Parquet/CSV (default: the checked-in places.csv)")
    parser.add_argument("--queries", help="queries YAML (default: the checked-in queries.yaml)")
    parser.add_argument("--save-vectors", help="write the place vectors to this .npy file")
    parser.add_argument("--doc-vectors", help="use place vectors from this .npy file (see above)")
    parser.add_argument("--out", type=Path, help="with --all: directory for one JSON file per model")
    args = parser.parse_args()
    if args.all:
        args.out = args.out or HERE / "spike_results"
        args.out.mkdir(parents=True, exist_ok=True)
        models = args.models.split(",") if args.models else DEFAULT_MODELS
        for model in models:
            cmd = [sys.executable, __file__, model, "--batch-size", str(args.batch_size)]
            for flag in ("threads", "corpus", "queries"):
                if getattr(args, flag):
                    cmd += [f"--{flag}", str(getattr(args, flag))]
            if args.save_vectors:
                cmd += ["--save-vectors", f"{args.save_vectors}-{model}.npy"]
            print(f"== {model}", flush=True)
            done = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
            if done.returncode != 0:
                print(done.stderr[-2000:], flush=True)
                continue
            line = done.stdout.strip().splitlines()[-1]
            (args.out / f"{model}.json").write_text(line + "\n", encoding="utf-8")
            summary = json.loads(line)
            print({k: summary[k] for k in ("rss_after_load_mb", "peak_rss_mb", "docs_per_s", "query_ms_p50")})
            print(summary["overall"], flush=True)
        return 0
    if not args.model:
        parser.error("give a model or --all")
    print(json.dumps(run_one(args), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
