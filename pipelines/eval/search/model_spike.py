"""The embeddings spike (docs/embeddings-spike.md): one local model, measured.

    python eval/search/model_spike.py MODEL [--threads 4]          # one model, prints one JSON line
    python eval/search/model_spike.py --all [--threads 4]          # each model in its own process

Each model runs in a fresh process so the memory numbers are its own. It embeds the labelled corpus
(places.csv), runs the labelled queries (queries.yaml) against it with brute-force cosine and reports

- load_s, rss_after_load_mb: time and resident memory right after the model is loaded
- docs_per_s: throughput embedding the corpus with the pipeline's batch size
- peak_rss_mb: peak working set over the whole run (Windows) or max RSS (Linux)
- query_ms_p50 / p95: one query at a time, warm, which is what the API does
- the metrics from `evaluate`: recall@k, success@k, MRR, NDCG@10, overall and by kind and language

Models other than `fake` and the ONNX ones need `pip install sentence-transformers` (spike only).
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


def run_one(model: str, threads: int | None, batch_size: int, query_reps: int) -> dict:
    import numpy as np

    from trippr_data.embed.embedders import make_embedder
    from trippr_data.embed.evaluate import evaluate, load_queries
    from trippr_data.embed.inputs import read_places
    from trippr_data.embed.text import build_texts

    corpus = HERE / "places.csv"
    places = read_places(corpus)
    texts = build_texts(places)
    queries = load_queries(HERE / "queries.yaml", corpus)

    base_rss, _ = rss_mb()
    t0 = time.perf_counter()
    embedder = make_embedder(model, threads=threads)
    embedder.embed_documents(["warm up"])  # first call builds kernels and buffers
    load_s = time.perf_counter() - t0
    after_load, _ = rss_mb()

    t0 = time.perf_counter()
    chunks = [embedder.embed_documents(texts[i : i + batch_size]) for i in range(0, len(texts), batch_size)]
    embed_s = time.perf_counter() - t0
    matrix = np.concatenate(chunks)

    latencies = []
    for i in range(query_reps):
        text = queries[i % len(queries)].text
        t0 = time.perf_counter()
        embedder.embed_queries([text])
        latencies.append((time.perf_counter() - t0) * 1000)

    result = evaluate(queries, embedder, [p.place_id for p in places], matrix)
    after_run, peak = rss_mb()
    return {
        "model": model,
        "version": embedder.version,
        "dims": embedder.dims,
        "threads": threads,
        "corpus": len(texts),
        "queries": len(queries),
        "baseline_rss_mb": round(base_rss),
        "rss_after_load_mb": round(after_load),
        "rss_after_run_mb": round(after_run),
        "peak_rss_mb": round(peak),
        "load_s": round(load_s, 1),
        "docs_per_s": round(len(texts) / embed_s, 1),
        "embed_corpus_s": round(embed_s, 1),
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
    parser.add_argument("--threads", type=int)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--query-reps", type=int, default=60)
    parser.add_argument("--out", type=Path, help="with --all: directory for one JSON file per model")
    args = parser.parse_args()
    if args.all:
        args.out = args.out or HERE / "spike_results"
        args.out.mkdir(parents=True, exist_ok=True)
        for model in DEFAULT_MODELS:
            cmd = [sys.executable, __file__, model, "--batch-size", str(args.batch_size)]
            if args.threads:
                cmd += ["--threads", str(args.threads)]
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
    print(json.dumps(run_one(args.model, args.threads, args.batch_size, args.query_reps), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
