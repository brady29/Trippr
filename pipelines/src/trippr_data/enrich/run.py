"""The enrich stage: plan, estimate, guard, submit, collect, write the enrichment Parquet."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from ..duck import connect, run
from .batches import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_MAX_WAIT_HOURS,
    DEFAULT_POLL_SECONDS,
    BatchRunner,
    CollectSummary,
)
from .estimate import DEFAULT_OUTPUT_TOKENS, BudgetExceededError, Estimate, check_budget, estimate_requests
from .inputs import EnrichInput
from .prompt import PROMPT_VERSION, build_params, source_label
from .schema import Enrichment


class ConfirmationRequiredError(Exception):
    """Spending needs --yes. Nothing was submitted."""


def parse_enrichment(text: str) -> dict[str, Any]:
    """Validate the model's JSON; the error names each bad field on one line (it is stored as the failure)."""
    try:
        return Enrichment.model_validate_json(text).model_dump()
    except ValidationError as err:
        raise ValueError(
            "invalid enrichment: "
            + "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in err.errors())
        ) from err


def make_runner(
    client: Any, root: Path, model: str, sleep: Callable[[float], None] = time.sleep
) -> BatchRunner:
    return BatchRunner(
        client,
        root,
        kind="enrich",
        model=model,
        prompt_version=PROMPT_VERSION,
        parse=parse_enrichment,
        sleep=sleep,
    )


@dataclass
class EnrichResult:
    n_places: int = 0
    n_unique: int = 0
    n_cached: int = 0
    n_in_flight: int = 0
    n_exhausted: int = 0
    n_to_submit: int = 0
    estimate: Estimate | None = None
    batch_ids: list[str] = field(default_factory=list)
    collected: CollectSummary = field(default_factory=CollectSummary)
    output: Path | None = None
    n_enriched: int = 0
    n_missing: int = 0
    dry_run: bool = False


def ai_label(place: EnrichInput, summary: str) -> str | None:
    """The sentence the app shows beside an AI-written summary."""
    if not summary:
        return None
    names = [source_label(s) for s in place.label_sources()]
    if not names:
        return "Summary written by AI"
    joined = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
    return f"Summary written by AI from {joined}"


ENRICHED_COLUMNS = """
    place_id VARCHAR, content_hash VARCHAR, tags VARCHAR[], summary VARCHAR, duration_min INTEGER,
    best_time VARCHAR, indoor BOOLEAN, price_level VARCHAR, good_for VARCHAR[], display_name VARCHAR, is_generic_name BOOLEAN, ai BOOLEAN, ai_label VARCHAR,
    summary_ai BOOLEAN, model VARCHAR, prompt_version VARCHAR, enriched_at TIMESTAMP WITH TIME ZONE,
    batch_id VARCHAR, input_sources VARCHAR[]
"""

PROVENANCE = """{
    'summary_ai': summary_ai, 'model': model, 'prompt_version': prompt_version, 'enriched_at': enriched_at,
    'batch_id': batch_id, 'input_sources': input_sources
}"""


def write_enrichment(path: Path, places: list[EnrichInput], runner: BatchRunner) -> int:
    """Join places to their cached answers and write Parquet. Returns how many places were enriched."""
    rows: list[tuple] = []
    for place in places:
        entry = runner.cache.get(runner.key_for(place.content_hash()))
        if not entry:
            continue
        v = entry["value"]
        rows.append(
            (
                place.place_id,
                place.content_hash(),
                v["tags"],
                v["summary"],
                v["duration_min"],
                v["best_time"],
                v["indoor"],
                v["price_level"],
                v["good_for"],
                v["display_name"],
                v["is_generic_name"],
                True,  # ai: every enriched field is model output
                ai_label(place, v["summary"]),
                bool(v["summary"]),  # the summary itself is AI-written (false when it came back empty)
                entry["model"],
                entry["prompt_version"],
                datetime.fromisoformat(entry["enriched_at"]),
                entry["batch_id"],
                place.label_sources(),
            )
        )
    con = connect()
    run(con, f"CREATE TABLE flat ({ENRICHED_COLUMNS})")
    if rows:
        con.executemany(f"INSERT INTO flat VALUES ({', '.join('?' * 19)})", rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".parquet.tmp")
    run(
        con,
        "COPY (SELECT place_id, content_hash, tags, summary, duration_min, best_time, indoor, price_level, "
        f"good_for, display_name, is_generic_name, ai, ai_label, {PROVENANCE} AS provenance FROM flat ORDER BY place_id) "
        f"TO '{tmp.as_posix()}' (FORMAT parquet, COMPRESSION zstd)",
    )
    tmp.replace(path)
    return len(rows)


def execute(
    runner: BatchRunner,
    requests: dict[str, dict[str, Any]],
    *,
    client: Any | None,
    model: str,
    budget_usd: float,
    dry_run: bool,
    yes: bool,
    wait: bool,
    batch_size: int,
    poll_seconds: float,
    max_wait_hours: float,
    output_tokens: int,
    extrapolate_to: int | None = None,
    report: Callable[[str], None] = print,
    summary_line: str = "",
) -> tuple[Estimate, list[str], CollectSummary]:
    """Estimate, guard, submit and collect one set of requests (key -> create params).

    Spends nothing unless every check passes: the estimate is within budget_usd (BudgetExceededError)
    and yes is set (ConfirmationRequiredError). dry_run only estimates.
    """
    est = estimate_requests(
        list(requests.values()),
        model,
        client=client,
        output_tokens=output_tokens,
        extrapolate_to=extrapolate_to,
    )
    if summary_line:
        report(summary_line)
    if requests:
        report(est.render(budget_usd))
    batch_ids: list[str] = []
    collected = CollectSummary()
    if dry_run:
        return est, batch_ids, collected
    if requests:
        check_budget(est, budget_usd)
        if not yes:
            raise ConfirmationRequiredError(
                f"Would submit {len(requests):,} requests for about ${est.total_usd:,.2f}. Rerun with --yes to spend it."
            )
        batch_ids = runner.submit(
            requests,
            usd_per_request=est.total_usd / len(requests),
            budget_usd=budget_usd,
            batch_size=batch_size,
        )
    if (requests or runner.state.in_flight()) and wait:
        collected = runner.collect_ready(wait=True, poll_seconds=poll_seconds, max_wait_hours=max_wait_hours)
    return est, batch_ids, collected


def enrich_places(
    client: Any | None,
    places: list[EnrichInput],
    root: Path,
    *,
    model: str,
    effort: str,
    budget_usd: float,
    dry_run: bool = False,
    yes: bool = False,
    wait: bool = True,
    batch_size: int = DEFAULT_BATCH_SIZE,
    poll_seconds: float = DEFAULT_POLL_SECONDS,
    max_wait_hours: float = DEFAULT_MAX_WAIT_HOURS,
    output_tokens: int = DEFAULT_OUTPUT_TOKENS,
    extrapolate_to: int | None = None,
    output: Path | None = None,
    sleep: Callable[[float], None] = time.sleep,
    report: Callable[[str], None] = print,
) -> EnrichResult:
    """Enrich places through the Batch API. Raises BudgetExceededError or ConfirmationRequiredError
    before spending anything the cap or the missing --yes does not allow."""
    runner = make_runner(client, root, model, sleep)
    result = EnrichResult(n_places=len(places), dry_run=dry_run)

    if client is not None and not dry_run:
        result.collected.add(runner.collect_ready())  # pick up batches that finished since the last run

    by_key: dict[str, EnrichInput] = {}
    for place in places:
        by_key.setdefault(runner.key_for(place.content_hash()), place)
    result.n_unique = len(by_key)
    in_flight = runner.state.in_flight_keys()
    result.n_cached = sum(1 for k in by_key if k in runner.cache)
    result.n_in_flight = sum(1 for k in by_key if k not in runner.cache and k in in_flight)
    result.n_exhausted = sum(
        1 for k in by_key if k not in runner.cache and k not in in_flight and runner.state.exhausted(k)
    )
    todo = runner.todo(list(by_key))
    result.n_to_submit = len(todo)

    requests = {k: build_params(by_key[k], model, effort) for k in todo}
    result.estimate, result.batch_ids, collected = execute(
        runner,
        requests,
        client=client,
        model=model,
        budget_usd=budget_usd,
        dry_run=dry_run,
        yes=yes,
        wait=wait,
        batch_size=batch_size,
        poll_seconds=poll_seconds,
        max_wait_hours=max_wait_hours,
        output_tokens=output_tokens,
        extrapolate_to=extrapolate_to if dry_run else None,
        report=report,
        summary_line=(
            f"{result.n_places:,} places ({result.n_unique:,} distinct): {result.n_cached:,} cached, "
            f"{result.n_in_flight:,} in flight, {result.n_exhausted:,} out of attempts, "
            f"{result.n_to_submit:,} to send"
        ),
    )
    result.collected.add(collected)
    if dry_run:
        return result

    if output is not None:
        result.n_enriched = write_enrichment(output, places, runner)
        result.n_missing = len(places) - result.n_enriched
        result.output = output
    return result


__all__ = [
    "BudgetExceededError",
    "ConfirmationRequiredError",
    "EnrichResult",
    "enrich_places",
    "execute",
    "make_runner",
    "parse_enrichment",
    "write_enrichment",
]
