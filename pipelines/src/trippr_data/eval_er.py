"""Entity-resolution evaluation: sample candidate pairs for hand labelling, then score the matcher.

`sample_pairs` writes eval/er_pairs.csv: candidate pairs from the blocking step, stratified by how
confident the matcher is (the scores are NOT written to the file, so labelling is not anchored by them).
A person fills the `label` column: 1 = the same real-world place, 0 = different places, ? = cannot tell
(left out of the numbers). `evaluate` re-runs matching for the labelled cities and reports precision and
recall of "the two records ended up in the same cluster" at the configured threshold and over a sweep.
"""

from __future__ import annotations

import csv
import logging
from dataclasses import replace
from pathlib import Path
from typing import Any

import duckdb

from .duck import rows, run
from .layout import eval_file, staged_sources, write_json
from .match import (
    MatchConfig,
    accepted_edges,
    candidate_pairs,
    cluster_edges,
    load_families,
    open_match_connection,
    prepare_city,
    score_candidates,
    strong_links,
)
from .settings import CONFIG_DIR

log = logging.getLogger(__name__)

EVAL_CITIES = ("UKY", "SHA", "PUS", "HAN", "CNX", "RMQ")
PAIRS_PER_CITY = 68
SWEEP = (0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95)
CSV_COLUMNS = (
    "pair_id",
    "city_code",
    "distance_m",
    "a_record",
    "a_name",
    "a_name_en",
    "a_name_local",
    "a_category",
    "a_address",
    "a_website",
    "a_qid",
    "b_record",
    "b_name",
    "b_name_en",
    "b_name_local",
    "b_category",
    "b_address",
    "b_website",
    "b_qid",
    "label",
    "note",
)

# Strata (name, share of a city's pairs): sampled by the matcher's confidence, so both sure and
# borderline pairs are labelled and recall is not measured only on easy cases.
STRATA = (
    ("strong", 0.08, "EXISTS (SELECT 1 FROM strong s WHERE s.ra = scored.ra AND s.rb = scored.rb)"),
    ("high", 0.22, "score >= 0.90"),
    ("upper", 0.22, "score >= 0.78 AND score < 0.90"),
    ("borderline", 0.24, "score >= 0.60 AND score < 0.78"),
    ("low", 0.16, "score >= 0.40 AND score < 0.60"),
    ("far", 0.08, "score < 0.40 AND name_sim >= 0.35"),
)


def sample_pairs(
    out: Path,
    date: str,
    csv_path: Path,
    *,
    cities: tuple[str, ...] = EVAL_CITIES,
    per_city: int = PAIRS_PER_CITY,
    cfg: MatchConfig | None = None,
    config_dir: Path = CONFIG_DIR,
) -> int:
    """Write a labelling CSV of candidate pairs; returns the number of pairs."""
    cfg = cfg or MatchConfig()
    con = open_match_connection(out, date, staged_sources(out, date), temp_dir=out / "tmp" / "duckdb")
    load_families(con, config_dir)
    written: list[dict[str, Any]] = []
    for city in cities:
        prepare_city(con, city, cfg)
        candidate_pairs(con, cfg)
        score_candidates(con, cfg)
        strong_links(con, cfg)
        picked: dict[tuple[str, str], str] = {}
        for stratum, share, where in STRATA:
            want = round(per_city * share)
            for r in rows(
                con,
                f"""SELECT ra, rb FROM scored WHERE {where}
                    ORDER BY hash(ra || '|' || rb || '{city}') LIMIT {want * 3}""",
            ):
                key = (r["ra"], r["rb"])
                if key not in picked and sum(1 for v in picked.values() if v == stratum) < want:
                    picked[key] = stratum
        # top up from the borderline pool when a stratum was short
        if len(picked) < per_city:
            for r in rows(
                con,
                f"SELECT ra, rb FROM scored WHERE score >= 0.5 ORDER BY hash(rb || '|' || ra || '{city}') LIMIT {per_city * 4}",
            ):
                if len(picked) >= per_city:
                    break
                picked.setdefault((r["ra"], r["rb"]), "topup")
        details = _pair_details(con, list(picked))
        written.extend(details)
        log.info("eval sample %s: %d pairs", city, len(details))
    con.close()
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    existing = _read_labels(csv_path) if csv_path.is_file() else {}
    with open(csv_path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_COLUMNS, lineterminator="\n")
        writer.writeheader()
        for i, row in enumerate(
            sorted(written, key=lambda r: (r["city_code"], r["a_record"], r["b_record"])), 1
        ):
            row["pair_id"] = f"{row['city_code']}-{i:03d}"
            prior = existing.get((row["a_record"], row["b_record"]))
            if prior:
                row["label"], row["note"] = prior["label"], prior["note"]
            writer.writerow({c: row.get(c, "") for c in CSV_COLUMNS})
    return len(written)


def _pair_details(con: duckdb.DuckDBPyConnection, pairs: list[tuple[str, str]]) -> list[dict[str, Any]]:
    if not pairs:
        return []
    run(con, "CREATE OR REPLACE TABLE picked (ra VARCHAR, rb VARCHAR)")
    con.executemany("INSERT INTO picked VALUES (?, ?)", [list(p) for p in pairs])
    return rows(
        con,
        """SELECT s1.city_code, round(1000 * hav_km(s1.lat, s1.lon, s2.lat, s2.lon)) AS distance_m,
                  p.ra AS a_record, s1.name AS a_name, s1.name_en AS a_name_en, s1.name_local AS a_name_local,
                  s1.category AS a_category, s1.address AS a_address, s1.website AS a_website, s1.wikidata_qid AS a_qid,
                  p.rb AS b_record, s2.name AS b_name, s2.name_en AS b_name_en, s2.name_local AS b_name_local,
                  s2.category AS b_category, s2.address AS b_address, s2.website AS b_website, s2.wikidata_qid AS b_qid
           FROM picked p
           JOIN staged s1 ON s1.source || ':' || s1.source_id = p.ra
           JOIN staged s2 ON s2.source || ':' || s2.source_id = p.rb""",
    )


def _read_labels(path: Path) -> dict[tuple[str, str], dict[str, str]]:
    with open(path, encoding="utf-8", newline="") as fh:
        return {(r["a_record"], r["b_record"]): r for r in csv.DictReader(fh)}


def load_labelled(path: Path) -> list[dict[str, str]]:
    """Rows with a label of 1 or 0; unlabelled and '?' rows are ignored."""
    with open(path, encoding="utf-8", newline="") as fh:
        return [r for r in csv.DictReader(fh) if r["label"].strip() in ("0", "1")]


def _metrics(tp: int, fp: int, fn: int) -> dict[str, float | int]:
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
    }


def evaluate(
    out: Path,
    date: str,
    labels_path: Path,
    *,
    cfg: MatchConfig | None = None,
    sweep: tuple[float, ...] = SWEEP,
    config_dir: Path = CONFIG_DIR,
    write: bool = True,
) -> dict[str, Any]:
    """Precision and recall of 'same cluster' on the labelled pairs, at cfg.threshold and over a sweep."""
    cfg = cfg or MatchConfig()
    labelled = load_labelled(labels_path)
    if not labelled:
        raise ValueError(f"{labels_path} has no labelled pairs (label 1 or 0)")
    unsure = sum(1 for _ in _read_labels(labels_path).values()) - len(labelled)
    thresholds = sorted({round(t, 4) for t in (*sweep, cfg.threshold)})
    by_city: dict[str, list[dict[str, str]]] = {}
    for r in labelled:
        by_city.setdefault(r["city_code"], []).append(r)
    con = open_match_connection(out, date, staged_sources(out, date), temp_dir=out / "tmp" / "duckdb")
    load_families(con, config_dir)
    counts = {t: {"tp": 0, "fp": 0, "fn": 0, "tn": 0} for t in thresholds}
    per_city: dict[str, dict[float, dict[str, int]]] = {}
    errors: dict[str, list[dict[str, Any]]] = {"false_positives": [], "false_negatives": []}
    for city, pairs in by_city.items():
        prepare_city(con, city, cfg)
        candidate_pairs(con, cfg)
        score_candidates(con, cfg)
        strong_links(con, cfg)
        coords = {r: (lat, lon) for r, lat, lon in run(con, "SELECT rid, lat, lon FROM recs")}
        per_city[city] = {}
        for t in thresholds:
            cfg_t = replace(cfg, threshold=t)
            assigned, _ = cluster_edges(city, accepted_edges(con, cfg_t), coords, cfg_t)
            c = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
            for r in pairs:
                a, b = r["a_record"], r["b_record"]
                same = a in assigned and b in assigned and assigned[a][0] == assigned[b][0]
                truth = r["label"].strip() == "1"
                key = ("tp" if truth else "fp") if same else ("fn" if truth else "tn")
                c[key] += 1
                if (
                    t == cfg.threshold
                    and key in ("fp", "fn")
                    and len(errors["false_positives"]) + len(errors["false_negatives"]) < 200
                ):
                    errors["false_positives" if key == "fp" else "false_negatives"].append(
                        {
                            "pair_id": r["pair_id"],
                            "a": f"{r['a_record']} {r['a_name']}",
                            "b": f"{r['b_record']} {r['b_name']}",
                            "distance_m": r["distance_m"],
                        }
                    )
            per_city[city][t] = c
            for k, v in c.items():
                counts[t][k] += v
    con.close()
    result = {
        "labels_file": str(labels_path),
        "pairs_labelled": len(labelled),
        "pairs_unsure_excluded": unsure,
        "positives": sum(1 for r in labelled if r["label"].strip() == "1"),
        "threshold": cfg.threshold,
        "at_threshold": _metrics(**{k: counts[cfg.threshold][k] for k in ("tp", "fp", "fn")}),
        "sweep": {f"{t:.2f}": _metrics(**{k: counts[t][k] for k in ("tp", "fp", "fn")}) for t in thresholds},
        "by_city": {
            city: _metrics(**{k: per_city[city][cfg.threshold][k] for k in ("tp", "fp", "fn")})
            | {"pairs": len(by_city[city])}
            for city in per_city
        },
        "targets": {"precision": 0.95, "recall": 0.85},
        "labelled_by": "the pipeline author (an AI assistant), not yet reviewed by a person",
        "errors": errors,
    }
    result["meets_targets"] = (
        result["at_threshold"]["precision"] >= 0.95 and result["at_threshold"]["recall"] >= 0.85
    )
    if write:
        write_json(eval_file(out, date), result)
    return result


def format_eval(result: dict[str, Any]) -> str:
    at = result["at_threshold"]
    lines = [
        f"Entity resolution on {result['pairs_labelled']} labelled pairs ({result['positives']} matches)",
        f"threshold {result['threshold']}: precision {at['precision']:.1%}, recall {at['recall']:.1%}, "
        f"F1 {at['f1']:.1%} (tp {at['tp']}, fp {at['fp']}, fn {at['fn']}); targets 95% / 85%",
        "",
        "| Threshold | Precision | Recall | F1 |",
        "|---:|---:|---:|---:|",
    ]
    for t, m in result["sweep"].items():
        lines.append(f"| {t} | {m['precision']:.1%} | {m['recall']:.1%} | {m['f1']:.1%} |")
    return "\n".join(lines)
