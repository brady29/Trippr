"""Search relevance eval: labelled queries against an embed run, with brute-force cosine as the reference.

The vector index in the graph database (PR 5's later half) is approximate and filtered; this is the
exact answer it is measured against. Both the model comparison (docs/embeddings-spike.md) and the
monthly "is search still good" check use it.

Queries live in YAML:

    queries:
      - id: n-ja-sensoji
        text: 浅草寺
        lang: ja
        kind: name            # name | category | intent: results are reported per kind and per language
        relevant: [overture:abc, foursquare:xyz]        # place ids ...
      - id: c-en-kyoto-temples
        text: temples in Kyoto
        lang: en
        kind: category
        match: {city_code: UKY, category: [temple_shrine]}   # ... or a rule over the corpus columns

Metrics (every relevant place counts the same):

- recall@k: share of a query's relevant places found in the top k, averaged over queries
- success@k: share of queries with at least one relevant place in the top k
- MRR: mean of 1 / rank of the first relevant place
- NDCG@10: with binary gains
"""

from __future__ import annotations

import logging
import math
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import yaml

from ..duck import connect, rows, sql_str
from ..layout import write_json
from .embedders import Embedder

log = logging.getLogger(__name__)

KS = (1, 5, 10)
NDCG_K = 10


@dataclass(frozen=True)
class Query:
    id: str
    text: str
    lang: str
    kind: str
    relevant: frozenset[str]


def _corpus_rows(corpus: str | Path) -> list[dict[str, Any]]:
    con = connect()
    try:
        path = str(corpus).replace("\\", "/")
        if path.lower().endswith((".csv", ".tsv")):
            source = f"read_csv({sql_str(path)}, header=true, all_varchar=true)"
        else:
            source = f"read_parquet({sql_str(path)}, union_by_name=true)"
        return rows(con, f"SELECT * FROM {source}")
    finally:
        con.close()


def resolve_match(
    rule: Mapping[str, Any], corpus_rows: Sequence[Mapping[str, Any]], id_column: str
) -> set[str]:
    """Ids of corpus rows where every field in the rule equals (or, for a list, is one of) its value."""
    found: set[str] = set()
    for row in corpus_rows:
        for field, wanted in rule.items():
            allowed = wanted if isinstance(wanted, list) else [wanted]
            if field not in row or row[field] not in allowed:
                break
        else:
            found.add(str(row[id_column]))
    return found


def load_queries(path: Path, corpus: str | Path | None = None, id_column: str = "place_id") -> list[Query]:
    with open(path, encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    corpus_rows = _corpus_rows(corpus) if corpus else []
    queries: list[Query] = []
    for entry in doc["queries"]:
        relevant = {str(r) for r in entry.get("relevant", [])}
        if "match" in entry:
            if not corpus_rows:
                raise ValueError(f"{entry['id']}: a 'match' rule needs the corpus")
            relevant |= resolve_match(entry["match"], corpus_rows, id_column)
        if not relevant:
            raise ValueError(f"query {entry['id']!r} has no relevant places")
        queries.append(
            Query(
                id=entry["id"],
                text=entry["text"],
                lang=entry.get("lang", "en"),
                kind=entry.get("kind", "other"),
                relevant=frozenset(relevant),
            )
        )
    ids = [q.id for q in queries]
    if len(set(ids)) != len(ids):
        raise ValueError("query ids are not unique")
    return queries


def rank_all(query_vectors: np.ndarray, matrix: np.ndarray, ids: Sequence[str], top: int) -> list[list[str]]:
    """Brute-force cosine (the vectors are unit length, so a dot product), best first, ties by id."""
    scores = query_vectors @ matrix.T
    order = np.array(ids)
    result = []
    for row in scores:
        # lexsort: last key is primary. Score descending, then id ascending for repeatable ties.
        idx = np.lexsort((order, -row))[:top]
        result.append([ids[i] for i in idx])
    return result


def _ndcg(ranked: Sequence[str], relevant: frozenset[str], k: int) -> float:
    dcg = sum(1.0 / math.log2(i + 2) for i, pid in enumerate(ranked[:k]) if pid in relevant)
    ideal = sum(1.0 / math.log2(i + 2) for i in range(min(k, len(relevant))))
    return dcg / ideal if ideal else 0.0


def score_query(ranked: Sequence[str], relevant: frozenset[str]) -> dict[str, float]:
    metrics: dict[str, float] = {}
    for k in KS:
        hits = sum(1 for pid in ranked[:k] if pid in relevant)
        metrics[f"recall@{k}"] = hits / len(relevant)
        metrics[f"success@{k}"] = 1.0 if hits else 0.0
    first = next((i + 1 for i, pid in enumerate(ranked) if pid in relevant), None)
    metrics["mrr"] = 1.0 / first if first else 0.0
    metrics[f"ndcg@{NDCG_K}"] = _ndcg(ranked, relevant, NDCG_K)
    return metrics


def _mean(per_query: Sequence[Mapping[str, float]]) -> dict[str, float]:
    keys = per_query[0].keys()
    return {k: round(sum(m[k] for m in per_query) / len(per_query), 4) for k in keys} | {
        "queries": len(per_query)
    }


def evaluate(
    queries: Sequence[Query],
    embedder: Embedder,
    ids: Sequence[str],
    matrix: np.ndarray,
) -> dict[str, Any]:
    """Embed the queries, rank the whole corpus for each and summarise. Missing ids in `relevant`
    (places not in the embedded corpus) are an error: the labels and the corpus must agree."""
    known = set(ids)
    for q in queries:
        missing = q.relevant - known
        if missing:
            raise ValueError(
                f"query {q.id!r} names places that are not in the embeddings: {sorted(missing)[:3]}"
            )
    query_vectors = embedder.embed_queries([q.text for q in queries])
    top = max(max(KS), NDCG_K)
    ranked = rank_all(query_vectors, matrix, ids, top)
    scored = [score_query(r, q.relevant) for r, q in zip(ranked, queries, strict=True)]

    groups: dict[str, dict[str, list[dict[str, float]]]] = {
        "kind": defaultdict(list),
        "lang": defaultdict(list),
    }
    for q, m in zip(queries, scored, strict=True):
        groups["kind"][q.kind].append(m)
        groups["lang"][q.lang].append(m)
    return {
        "overall": _mean(scored),
        "by_kind": {k: _mean(v) for k, v in sorted(groups["kind"].items())},
        "by_lang": {k: _mean(v) for k, v in sorted(groups["lang"].items())},
        "per_query": [
            {
                "id": q.id,
                "text": q.text,
                "kind": q.kind,
                "lang": q.lang,
                "relevant": len(q.relevant),
                "mrr": round(m["mrr"], 4),
                "recall@10": round(m["recall@10"], 4),
                "top3": ranked[i][:3],
            }
            for i, (q, m) in enumerate(zip(queries, scored, strict=True))
        ],
    }


COLUMNS = ("recall@1", "recall@5", "recall@10", "success@1", "success@5", "mrr", f"ndcg@{NDCG_K}")


def render_markdown(result: Mapping[str, Any], model: str) -> str:
    def line(label: str, m: Mapping[str, float]) -> str:
        cells = " | ".join(f"{m[c]:.3f}" for c in COLUMNS)
        return f"| {label} | {m['queries']} | {cells} |"

    header = "| | queries | " + " | ".join(COLUMNS) + " |\n|---|---|" + "---|" * len(COLUMNS)
    body = [line("**all**", result["overall"])]
    body += [line(f"kind: {k}", m) for k, m in result["by_kind"].items()]
    body += [line(f"lang: {k}", m) for k, m in result["by_lang"].items()]
    return f"Search relevance ({model}, brute-force cosine)\n\n{header}\n" + "\n".join(body) + "\n"


def run_eval_search(
    embeddings_dir: Path,
    queries_path: Path,
    corpus: str | Path,
    embedder: Embedder,
    out: Path,
    date: str,
    *,
    min_mrr: float | None = None,
    min_recall10: float | None = None,
) -> tuple[bool, dict[str, Any]]:
    """Evaluate an embed run. The embedder must be the model the run used (checked against its manifest)."""
    from .run import load_run

    manifest, ids, matrix = load_run(embeddings_dir)
    if manifest["model"] != embedder.name or manifest["dims"] != embedder.dims:
        raise ValueError(
            f"embeddings were made with {manifest['model']} ({manifest['dims']} dims), "
            f"not {embedder.name} ({embedder.dims} dims)"
        )
    if manifest["version"] != embedder.version:
        log.warning("weights differ: embeddings %s, queries %s", manifest["version"], embedder.version)
    queries = load_queries(queries_path, corpus)
    result = evaluate(queries, embedder, ids, matrix)
    result["model"] = {k: manifest[k] for k in ("model", "version", "dims", "text_version")}
    result["corpus_size"] = len(ids)

    overall = result["overall"]
    failures = []
    if min_mrr is not None and overall["mrr"] < min_mrr:
        failures.append(f"MRR {overall['mrr']:.3f} < {min_mrr}")
    if min_recall10 is not None and overall["recall@10"] < min_recall10:
        failures.append(f"recall@10 {overall['recall@10']:.3f} < {min_recall10}")
    result["passed"] = not failures
    result["failures"] = failures
    write_json(out / "reports" / f"{date}.search-eval.json", result)
    return not failures, result
