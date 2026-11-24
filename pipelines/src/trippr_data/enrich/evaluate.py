"""The enrichment eval: run a model over the labelled places and score it.

Reference labels live in pipelines/eval/enrich_places.jsonl, hand-written (tags, typical visit duration,
best time of day, indoor or not) for about 150 places across Japan, China, Hong Kong, Macau, Taiwan, Korea,
Vietnam, Thailand, Cambodia, Laos, Malaysia, Singapore, Indonesia, the Philippines, Mongolia, Nepal and Sri
Lanka, so Latin, CJK, Hangul, Thai, Khmer, Lao, Devanagari and Sinhala names are all represented. The place
descriptions in it are short factual notes written for the eval, not copied from any source.

Metrics (spec targets in bold): tag precision, recall and F1 (**F1 >= 0.85**), duration within a tolerance
(30 minutes), best-time accuracy, indoor accuracy, the share of summaries with unsupported claims
(**<= 2%**, by the rule checks and, with --judge, by an LLM judge), and how many answers failed validation.
"""

from __future__ import annotations

import json
import time
import unicodedata
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict

from ..settings import PIPELINE_ROOT
from .batches import DEFAULT_BATCH_SIZE, DEFAULT_MAX_WAIT_HOURS, DEFAULT_POLL_SECONDS, BatchRunner
from .estimate import DEFAULT_OUTPUT_TOKENS, Estimate
from .faithfulness import format_problems, unsupported_terms
from .inputs import EnrichInput, taxonomy
from .judge import (
    JUDGE_PROMPT_VERSION,
    judge_content_hash,
    judge_params,
    parse_verdict,
)
from .pricing import usage_cost
from .run import enrich_places, execute, make_runner

EVAL_SET_PATH = PIPELINE_ROOT / "eval" / "enrich_places.jsonl"

TARGET_TAG_F1 = 0.85
TARGET_UNSUPPORTED = 0.02
TARGET_VALID = 0.98
DURATION_TOLERANCE_MIN = 30


class Reference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tags: list[str]
    duration_min: int | None = None
    best_time: str | None = None
    indoor: bool | None = None
    generic: bool = False  # the record's name is formal or generic (is_generic_name)
    display: str | None = None  # the name to show, where a real one is knowable


@dataclass(frozen=True)
class EvalPlace:
    place: EnrichInput
    ref: Reference
    country: str
    script: str


def script_of(*names: str | None) -> str:
    """The writing system of the first non-Latin letter in the names, else 'latin'."""
    for name in names:
        for ch in name or "":
            if not ch.isalpha():
                continue
            label = unicodedata.name(ch, "")
            for prefix, script in (
                ("CJK", "cjk"),
                ("HIRAGANA", "cjk"),
                ("KATAKANA", "cjk"),
                ("HANGUL", "hangul"),
                ("THAI", "thai"),
                ("KHMER", "khmer"),
                ("LAO", "lao"),
                ("DEVANAGARI", "devanagari"),
                ("SINHALA", "sinhala"),
                ("CYRILLIC", "cyrillic"),
            ):
                if label.startswith(prefix):
                    return script
    return "latin"


def load_eval_set(path: Path = EVAL_SET_PATH) -> list[EvalPlace]:
    """Compact JSON lines: id, name, local, en, cat, city, country, desc, tags, dur, best, indoor."""
    if not path.is_file():
        raise FileNotFoundError(f"Eval set not found: {path}")
    out: list[EvalPlace] = []
    seen: set[str] = set()
    with open(path, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            if not line.strip():
                continue
            raw = json.loads(line)
            if raw["id"] in seen:
                raise ValueError(f"{path}:{n}: duplicate id {raw['id']}")
            seen.add(raw["id"])
            desc = raw.get("desc")
            place = EnrichInput(
                place_id=raw["id"],
                name=raw["name"],
                name_local=raw.get("local"),
                name_en=raw.get("en"),
                category=raw["cat"],
                city_code=raw["city"],
                address=raw.get("addr"),
                description=desc,
                sources=["eval-notes"],
            )
            ref = Reference(
                tags=raw["tags"],
                duration_min=raw.get("dur"),
                best_time=raw.get("best"),
                indoor=raw.get("indoor"),
                generic=raw.get("generic", False),
                display=raw.get("display"),
            )
            unknown = [t for t in ref.tags if t not in taxonomy()]
            if unknown:
                raise ValueError(f"{path}:{n}: reference tags not in the taxonomy: {unknown}")
            out.append(EvalPlace(place, ref, raw["country"], script_of(place.name_local, place.name)))
    return out


# ---- scoring ---------------------------------------------------------------------------------------


def _ratio(num: float, den: float) -> float | None:
    return num / den if den else None


def score(
    items: list[EvalPlace],
    preds: dict[str, dict[str, Any] | None],
    verdicts: dict[str, dict[str, Any]] | None = None,
    tolerance: int = DURATION_TOLERANCE_MIN,
) -> dict[str, Any]:
    """Metrics over items. A place with no valid answer counts against every metric that has a reference."""
    tp = fp = fn = 0
    dur_n = dur_ok = bt_n = bt_ok = in_n = in_ok = 0
    answered = nonempty = rule_flagged = fmt_bad = judged = judge_flagged = 0
    g_tp = g_fp = g_fn = 0
    disp_n = disp_ok = named = named_flagged = 0
    for item in items:
        pred = preds.get(item.place.place_id)
        ref_tags = set(item.ref.tags)
        pred_tags = set(pred["tags"]) if pred else set()
        tp += len(ref_tags & pred_tags)
        fp += len(pred_tags - ref_tags)
        fn += len(ref_tags - pred_tags)
        if item.ref.duration_min is not None:
            dur_n += 1
            got = pred["duration_min"] if pred else None
            dur_ok += got is not None and abs(got - item.ref.duration_min) <= tolerance
        if item.ref.best_time is not None:
            bt_n += 1
            bt_ok += bool(pred) and pred["best_time"] == item.ref.best_time
        if item.ref.indoor is not None:
            in_n += 1
            in_ok += bool(pred) and pred["indoor"] == item.ref.indoor
        pred_generic = bool(pred and pred["is_generic_name"])
        g_tp += pred_generic and item.ref.generic
        g_fp += pred_generic and not item.ref.generic
        g_fn += (not pred_generic) and item.ref.generic
        if item.ref.display is not None:
            disp_n += 1
            disp_ok += bool(pred) and _same_name(pred["display_name"], item.ref.display)
        if not pred:
            continue
        answered += 1
        if pred["display_name"]:
            named += 1
            named_flagged += bool(unsupported_terms(pred["display_name"], item.place, is_name=True))
        summary = pred["summary"]
        if summary:
            nonempty += 1
            rule_flagged += bool(unsupported_terms(summary, item.place) or format_problems(summary))
            fmt_bad += bool(format_problems(summary))
            if verdicts is not None and item.place.place_id in verdicts:
                judged += 1
                judge_flagged += not verdicts[item.place.place_id]["supported"]
    precision, recall = _ratio(tp, tp + fp), _ratio(tp, tp + fn)
    f1 = _ratio(2 * precision * recall, precision + recall) if precision and recall else 0.0
    return {
        "n": len(items),
        "valid_rate": _ratio(answered, len(items)),
        "tag_precision": precision,
        "tag_recall": recall,
        "tag_f1": f1,
        "duration_within_tolerance": _ratio(dur_ok, dur_n),
        "best_time_accuracy": _ratio(bt_ok, bt_n),
        "indoor_accuracy": _ratio(in_ok, in_n),
        "summaries": nonempty,
        "summary_rule_unsupported_rate": _ratio(rule_flagged, nonempty),
        "summary_format_problem_rate": _ratio(fmt_bad, nonempty),
        "summary_judge_unsupported_rate": _ratio(judge_flagged, judged) if verdicts is not None else None,
        "summaries_judged": judged,
        "generic_precision": _ratio(g_tp, g_tp + g_fp),
        "generic_recall": _ratio(g_tp, g_tp + g_fn),
        "display_name_match": _ratio(disp_ok, disp_n),
        "display_name_unsupported_rate": _ratio(named_flagged, named),
    }


def _same_name(a: str | None, b: str) -> bool:
    """Display names match ignoring case, width, accents, spacing and punctuation."""
    if not a:
        return False

    def fold(text: str) -> str:
        decomposed = unicodedata.normalize("NFKD", text)
        return "".join(c for c in decomposed if not unicodedata.combining(c) and c.isalnum()).casefold()

    return fold(a) == fold(b)


def score_groups(
    items: list[EvalPlace],
    preds: dict[str, dict[str, Any] | None],
    verdicts: dict[str, dict[str, Any]] | None,
    tolerance: int,
    key: Callable[[EvalPlace], str],
) -> dict[str, dict[str, Any]]:
    groups: dict[str, list[EvalPlace]] = defaultdict(list)
    for item in items:
        groups[key(item)].append(item)
    return {g: score(v, preds, verdicts, tolerance) for g, v in sorted(groups.items())}


def passes_targets(metrics: dict[str, Any]) -> dict[str, bool]:
    unsupported = metrics["summary_judge_unsupported_rate"]
    if unsupported is None:
        unsupported = metrics["summary_rule_unsupported_rate"]
    return {
        "tag_f1": (metrics["tag_f1"] or 0) >= TARGET_TAG_F1,
        "unsupported_summaries": (unsupported or 0) <= TARGET_UNSUPPORTED,
        "valid_answers": (metrics["valid_rate"] or 0) >= TARGET_VALID,
    }


# ---- running ---------------------------------------------------------------------------------------


@dataclass
class EvalReport:
    model: str
    judge_model: str | None
    metrics: dict[str, Any] = field(default_factory=dict)
    by_script: dict[str, dict[str, Any]] = field(default_factory=dict)
    by_country: dict[str, dict[str, Any]] = field(default_factory=dict)
    targets: dict[str, bool] = field(default_factory=dict)
    cost: dict[str, float] = field(default_factory=dict)
    misses: list[dict[str, Any]] = field(default_factory=list)
    estimate: Estimate | None = None
    judge_estimate: Estimate | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "judge_model": self.judge_model,
            "metrics": self.metrics,
            "by_script": self.by_script,
            "by_country": self.by_country,
            "targets": self.targets,
            "cost": self.cost,
            "misses": self.misses,
        }

    @property
    def meets_targets(self) -> bool:
        return bool(self.targets) and all(self.targets.values())


def _typical_summary(item: EvalPlace) -> str:
    return f"{item.place.name} is a {taxonomy()[item.place.category].label.lower()} in the city, known for its setting."


def run_eval(
    client: Any | None,
    items: list[EvalPlace],
    root: Path,
    *,
    model: str,
    effort: str,
    budget_usd: float,
    judge_model: str | None = None,
    dry_run: bool = False,
    yes: bool = False,
    tolerance: int = DURATION_TOLERANCE_MIN,
    batch_size: int = DEFAULT_BATCH_SIZE,
    poll_seconds: float = DEFAULT_POLL_SECONDS,
    max_wait_hours: float = DEFAULT_MAX_WAIT_HOURS,
    output_tokens: int = DEFAULT_OUTPUT_TOKENS,
    extrapolate_to: int | None = None,
    sleep: Callable[[float], None] = time.sleep,
    report: Callable[[str], None] = print,
) -> EvalReport:
    """Enrich the eval places (cached, so a rerun is free), optionally judge the summaries, and score."""
    places = [i.place for i in items]
    result = enrich_places(
        client,
        places,
        root,
        model=model,
        effort=effort,
        budget_usd=budget_usd,
        dry_run=dry_run,
        yes=yes,
        wait=True,
        batch_size=batch_size,
        poll_seconds=poll_seconds,
        max_wait_hours=max_wait_hours,
        output_tokens=output_tokens,
        extrapolate_to=extrapolate_to,
        sleep=sleep,
        report=report,
    )
    out = EvalReport(model=model, judge_model=judge_model, estimate=result.estimate)

    runner = make_runner(client, root, model, sleep)
    preds: dict[str, dict[str, Any] | None] = {}
    for item in items:
        entry = runner.cache.get(runner.key_for(item.place.content_hash()))
        preds[item.place.place_id] = entry["value"] if entry else None

    verdicts: dict[str, dict[str, Any]] | None = None
    judge_runner: BatchRunner | None = None
    if judge_model:
        judge_runner = BatchRunner(
            client,
            root,
            kind="judge",
            model=judge_model,
            prompt_version=JUDGE_PROMPT_VERSION,
            parse=parse_verdict,
            sleep=sleep,
        )
        reqs: dict[str, dict[str, Any]] = {}
        key_of: dict[str, str] = {}
        for item in items:
            pred = preds[item.place.place_id]
            summary = pred["summary"] if pred else (_typical_summary(item) if dry_run else "")
            if not summary:
                continue
            key = judge_runner.key_for(judge_content_hash(item.place, summary))
            key_of[item.place.place_id] = key
            if key not in judge_runner.cache:
                reqs[key] = judge_params(item.place, summary, judge_model)
        todo = judge_runner.todo(list(reqs))
        out.judge_estimate, _, _ = execute(
            judge_runner,
            {k: reqs[k] for k in todo},
            client=client,
            model=judge_model,
            budget_usd=budget_usd,
            dry_run=dry_run,
            yes=yes,
            wait=True,
            batch_size=batch_size,
            poll_seconds=poll_seconds,
            max_wait_hours=max_wait_hours,
            output_tokens=120,
            extrapolate_to=extrapolate_to if dry_run else None,
            report=report,
            summary_line=f"Judge: {len(key_of):,} summaries, {len(todo):,} not yet judged",
        )
        if dry_run:
            return out
        verdicts = {}
        for pid, key in key_of.items():
            entry = judge_runner.cache.get(key)
            if entry:
                verdicts[pid] = entry["value"]
    if dry_run:
        return out

    out.metrics = score(items, preds, verdicts, tolerance)
    out.by_script = score_groups(items, preds, verdicts, tolerance, lambda i: i.script)
    out.by_country = score_groups(items, preds, verdicts, tolerance, lambda i: i.country)
    out.targets = passes_targets(out.metrics)
    out.cost = _cost(items, preds, runner, judge_runner, judge_model)
    out.misses = _misses(items, preds, verdicts)
    return out


def _cost(
    items: list[EvalPlace],
    preds: dict[str, dict[str, Any] | None],
    runner: BatchRunner,
    judge_runner: BatchRunner | None,
    judge_model: str | None,
) -> dict[str, float]:
    keys = {runner.key_for(i.place.content_hash()) for i in items if preds[i.place.place_id]}
    entries = [runner.cache.get(k) for k in keys]
    usd = sum(usage_cost(e["usage"], runner.model) for e in entries if e)
    n = max(len(entries), 1)
    cost = {
        "enrich_usd": round(usd, 4),
        "enrich_usd_per_1000_places": round(usd / n * 1000, 2),
        "avg_input_tokens": round(
            sum(
                e["usage"]["input_tokens"]
                + e["usage"]["cache_read_input_tokens"]
                + e["usage"]["cache_creation_input_tokens"]
                for e in entries
                if e
            )
            / n,
            1,
        ),
        "avg_output_tokens": round(sum(e["usage"]["output_tokens"] for e in entries if e) / n, 1),
    }
    if judge_runner and judge_model:
        judged = [e for e in judge_runner.cache.entries.values() if e["model"] == judge_model]
        cost["judge_usd"] = round(sum(usage_cost(e["usage"], judge_model) for e in judged), 4)
    return cost


def _misses(
    items: list[EvalPlace],
    preds: dict[str, dict[str, Any] | None],
    verdicts: dict[str, dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Places worth reading: no valid answer, no tag overlap, or a flagged summary."""
    out = []
    for item in items:
        pid = item.place.place_id
        pred = preds[pid]
        if not pred:
            out.append({"id": pid, "problem": "no valid answer"})
            continue
        if not set(pred["tags"]) & set(item.ref.tags):
            out.append({"id": pid, "problem": f"tags {pred['tags']} vs reference {item.ref.tags}"})
        flagged = unsupported_terms(pred["summary"], item.place)
        if flagged:
            out.append(
                {
                    "id": pid,
                    "problem": f"summary terms not in the input: {flagged}",
                    "summary": pred["summary"],
                }
            )
        if verdicts and pid in verdicts and not verdicts[pid]["supported"]:
            out.append(
                {
                    "id": pid,
                    "problem": f"judge: {verdicts[pid]['unsupported_claims']}",
                    "summary": pred["summary"],
                }
            )
    return out


# ---- rendering -------------------------------------------------------------------------------------


def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def _row(label: str, m: dict[str, Any]) -> str:
    return (
        f"| {label} | {m['n']} | {_pct(m['tag_precision'])} | {_pct(m['tag_recall'])} | {m['tag_f1']:.2f} | "
        f"{_pct(m['duration_within_tolerance'])} | {_pct(m['best_time_accuracy'])} | {_pct(m['indoor_accuracy'])} | "
        f"{_pct(m['summary_rule_unsupported_rate'])} | {_pct(m['summary_judge_unsupported_rate'])} | "
        f"{_pct(m['generic_recall'])} | {_pct(m['generic_precision'])} | {_pct(m['display_name_match'])} |"
    )


_HEADER = (
    "| | n | tag precision | tag recall | tag F1 | duration ±tol | best time | indoor | unsupported (rules) | unsupported (judge) | generic recall | generic precision | display name |\n"
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|"
)


def render_report(rep: EvalReport, tolerance: int = DURATION_TOLERANCE_MIN) -> str:
    m, c = rep.metrics, rep.cost
    verdict = "meets" if rep.meets_targets else "MISSES"
    lines = [
        f"# Enrichment eval: {rep.model}",
        "",
        f"{verdict} the targets (tag F1 >= {TARGET_TAG_F1}, unsupported summaries <= {TARGET_UNSUPPORTED:.0%}, "
        f"valid answers >= {TARGET_VALID:.0%}): "
        + ", ".join(f"{k} {'ok' if v else 'FAIL'}" for k, v in rep.targets.items()),
        f"Duration tolerance ±{tolerance} min. Valid answers: {_pct(m['valid_rate'])}. "
        f"Judge: {rep.judge_model or 'not run'}.",
        "",
        _HEADER,
        _row("all", m),
        *(_row(f"script: {k}", v) for k, v in rep.by_script.items()),
        *(_row(f"country: {k}", v) for k, v in rep.by_country.items()),
        "",
        f"Cost: ${c['enrich_usd']:.4f} for {m['n']} places = ${c['enrich_usd_per_1000_places']:.2f} per 1,000 places "
        f"(batch rates). Average {c['avg_input_tokens']:.0f} input and {c['avg_output_tokens']:.0f} output tokens per request"
        + (f"; judge ${c['judge_usd']:.4f}." if "judge_usd" in c else "."),
    ]
    if rep.misses:
        lines += ["", f"## Worth reading ({len(rep.misses)})", ""]
        lines += [
            f"- `{x['id']}`: {x['problem']}" + (f" - {x['summary']}" if "summary" in x else "")
            for x in rep.misses[:40]
        ]
    return "\n".join(lines) + "\n"


def render_comparison(reports: list[EvalReport]) -> str:
    lines = [
        "| model | tag F1 | duration | best time | unsupported | valid | $ / 1,000 places | meets targets |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in reports:
        m = r.metrics
        uns = m["summary_judge_unsupported_rate"]
        uns = m["summary_rule_unsupported_rate"] if uns is None else uns
        lines.append(
            f"| {r.model} | {m['tag_f1']:.2f} | {_pct(m['duration_within_tolerance'])} | {_pct(m['best_time_accuracy'])} | "
            f"{_pct(uns)} | {_pct(m['valid_rate'])} | ${r.cost['enrich_usd_per_1000_places']:.2f} | "
            f"{'yes' if r.meets_targets else 'no'} |"
        )
    ok = sorted((r for r in reports if r.meets_targets), key=lambda r: r.cost["enrich_usd_per_1000_places"])
    lines.append("")
    lines.append(
        f"Cheapest model that meets the targets: {ok[0].model}"
        if ok
        else "No model meets the targets yet; read the misses, adjust the prompt (bump PROMPT_VERSION) and rerun."
    )
    return "\n".join(lines) + "\n"


__all__ = [
    "EVAL_SET_PATH",
    "EvalPlace",
    "EvalReport",
    "load_eval_set",
    "passes_targets",
    "render_comparison",
    "render_report",
    "run_eval",
    "score",
]
