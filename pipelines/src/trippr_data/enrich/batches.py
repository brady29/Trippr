"""The Message Batches machinery: a content-hash cache, a resumable state file, submit and collect.

Everything the next run needs is on disk:
- <root>/<kind>.cache.jsonl   one validated answer per request key, appended as results arrive
- <root>/<kind>.state.json    every batch submitted (its keys, estimated and actual cost) and each key's failures

A request key is sha256(kind | model | prompt version | content hash), and it is also the batch custom_id, so a
result always finds its place, a run never resubmits a key that is cached or already in flight, and changing
the prompt, the model or a place's content re-enriches just what changed.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..layout import read_json, write_json
from ..settings import utc_now
from .estimate import BudgetExceededError
from .pricing import usage_cost

log = logging.getLogger("trippr_data.enrich")

MAX_ATTEMPTS = 3  # a key that fails this many times is left out until its content, prompt or model changes
DEFAULT_BATCH_SIZE = 2000
DEFAULT_POLL_SECONDS = 60
DEFAULT_MAX_WAIT_HOURS = 26  # batches finish within 24 hours


def request_key(kind: str, model: str, prompt_version: str, content_hash: str) -> str:
    return hashlib.sha256(f"{kind}|{model}|{prompt_version}|{content_hash}".encode()).hexdigest()


class JsonlCache:
    """Append-only key -> entry store. A torn last line (a crash mid-write) is ignored on load."""

    def __init__(self, path: Path):
        self.path = path
        self.entries: dict[str, dict[str, Any]] = {}
        if path.is_file():
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    self.entries[entry["key"]] = entry

    def __contains__(self, key: str) -> bool:
        return key in self.entries

    def __len__(self) -> int:
        return len(self.entries)

    def get(self, key: str) -> dict[str, Any] | None:
        return self.entries.get(key)

    def put(self, entry: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
        self.entries[entry["key"]] = entry


class BatchState:
    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, Any] = {"version": 1, "batches": [], "failures": {}}
        if path.is_file():
            self.data = read_json(path)

    def save(self) -> None:
        write_json(self.path, self.data)

    @property
    def batches(self) -> list[dict[str, Any]]:
        return self.data["batches"]

    def in_flight(self) -> list[dict[str, Any]]:
        return [b for b in self.batches if b["status"] == "in_progress"]

    def in_flight_keys(self) -> set[str]:
        return {k for b in self.in_flight() for k in b["keys"]}

    def attempts(self, key: str) -> int:
        return int(self.data["failures"].get(key, {}).get("attempts", 0))

    def exhausted(self, key: str) -> bool:
        return self.attempts(key) >= MAX_ATTEMPTS

    def record_failure(self, key: str, error: str) -> None:
        prior = self.data["failures"].get(key, {})
        self.data["failures"][key] = {
            "attempts": int(prior.get("attempts", 0)) + 1,
            "error": error[:500],
            "at": utc_now().isoformat(),
        }

    def clear_failure(self, key: str) -> None:
        self.data["failures"].pop(key, None)


@dataclass
class CollectSummary:
    batches: int = 0
    succeeded: int = 0
    failed: int = 0
    actual_usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    errors: list[str] = field(default_factory=list)

    def add(self, other: CollectSummary) -> None:
        self.batches += other.batches
        self.succeeded += other.succeeded
        self.failed += other.failed
        self.actual_usd += other.actual_usd
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.errors += other.errors


def _usage(usage: Any) -> dict[str, int]:
    names = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
    return {n: int(getattr(usage, n, 0) or 0) for n in names}


def _answer_text(message: Any) -> str:
    """The first text block (thinking blocks may come first), or raise ValueError."""
    stop = getattr(message, "stop_reason", None)
    if stop in ("max_tokens", "refusal"):
        raise ValueError(f"model stopped with {stop}")
    for block in message.content:
        if block.type == "text":
            return block.text
    raise ValueError("no text block in the response")


class BatchRunner:
    """Submits requests as batches and folds finished batches into the cache."""

    def __init__(
        self,
        client: Any,
        root: Path,
        *,
        kind: str,
        model: str,
        prompt_version: str,
        parse: Callable[[str], dict[str, Any]],
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.client = client
        self.kind = kind
        self.model = model
        self.prompt_version = prompt_version
        self.parse = parse
        self.sleep = sleep
        self.cache = JsonlCache(root / f"{kind}.cache.jsonl")
        self.state = BatchState(root / f"{kind}.state.json")

    def key_for(self, content_hash: str) -> str:
        return request_key(self.kind, self.model, self.prompt_version, content_hash)

    # ---- collecting ----------------------------------------------------------------------------

    def collect_ready(
        self,
        *,
        wait: bool = False,
        poll_seconds: float = DEFAULT_POLL_SECONDS,
        max_wait_hours: float = DEFAULT_MAX_WAIT_HOURS,
    ) -> CollectSummary:
        """Collect every in-flight batch that has ended. With wait=True, poll until all have."""
        total = CollectSummary()
        waited = 0.0
        while True:
            for entry in self.state.in_flight():
                batch = self.client.messages.batches.retrieve(entry["batch_id"])
                if batch.processing_status == "ended":
                    total.add(self._collect(entry))
            remaining = self.state.in_flight()
            if not remaining or not wait:
                return total
            if waited >= max_wait_hours * 3600:
                log.warning("gave up waiting for %d batch(es); rerun to resume", len(remaining))
                return total
            log.info(
                "waiting on %d batch(es): %s", len(remaining), ", ".join(b["batch_id"] for b in remaining)
            )
            self.sleep(poll_seconds)
            waited += poll_seconds

    def _collect(self, entry: dict[str, Any]) -> CollectSummary:
        summary = CollectSummary(batches=1)
        seen: set[str] = set()
        for item in self.client.messages.batches.results(entry["batch_id"]):
            key = item.custom_id
            seen.add(key)
            result = item.result
            try:
                if result.type != "succeeded":
                    envelope = getattr(result, "error", None)  # ErrorResponse -> .error -> .type
                    inner = getattr(envelope, "error", envelope)
                    detail = getattr(inner, "type", None) or result.type
                    raise ValueError(f"batch result {result.type}: {detail}")
                message = result.message
                usage = _usage(message.usage)
                summary.input_tokens += usage["input_tokens"] + usage["cache_read_input_tokens"]
                summary.output_tokens += usage["output_tokens"]
                summary.actual_usd += usage_cost(usage, self.model)
                value = self.parse(_answer_text(message))
            except ValueError as err:
                self.state.record_failure(key, str(err))
                summary.failed += 1
                summary.errors.append(f"{key[:12]}: {str(err).splitlines()[0][:200]}")
                continue
            self.cache.put(
                {
                    "key": key,
                    "kind": self.kind,
                    "model": self.model,
                    "prompt_version": self.prompt_version,
                    "batch_id": entry["batch_id"],
                    "enriched_at": utc_now().isoformat(),
                    "usage": usage,
                    "value": value,
                }
            )
            self.state.clear_failure(key)
            summary.succeeded += 1
        for key in set(entry["keys"]) - seen:
            self.state.record_failure(key, "no result returned for this request")
            summary.failed += 1
        entry["status"] = "collected"
        entry["collected_at"] = utc_now().isoformat()
        entry["actual_usd"] = round(summary.actual_usd, 6)
        entry["counts"] = {"succeeded": summary.succeeded, "failed": summary.failed}
        self.state.save()
        log.info(
            "batch %s: %d ok, %d failed, $%.4f",
            entry["batch_id"],
            summary.succeeded,
            summary.failed,
            summary.actual_usd,
        )
        return summary

    # ---- submitting ----------------------------------------------------------------------------

    def todo(self, keys: list[str]) -> list[str]:
        """Keys that still need a request: not cached, not in flight, not out of attempts."""
        in_flight = self.state.in_flight_keys()
        return [
            k
            for k in dict.fromkeys(keys)
            if k not in self.cache and k not in in_flight and not self.state.exhausted(k)
        ]

    def submit(
        self,
        requests: dict[str, dict[str, Any]],
        *,
        usd_per_request: float,
        budget_usd: float,
        batch_size: int = DEFAULT_BATCH_SIZE,
    ) -> list[str]:
        """Create one batch per chunk of requests (key -> create params), recording each as soon as it exists.

        The budget is re-checked before every chunk against what this call has already submitted, so a
        bad estimate stops the run part-way instead of after everything is spent.
        """
        keys = list(requests)
        submitted: list[str] = []
        spent = 0.0
        for start in range(0, len(keys), batch_size):
            chunk = keys[start : start + batch_size]
            chunk_usd = usd_per_request * len(chunk)
            if spent + chunk_usd > budget_usd + 1e-9:
                raise BudgetExceededError(
                    f"Submitting {len(chunk)} more requests (~${chunk_usd:,.2f}) would pass the ${budget_usd:,.2f} cap "
                    f"after ${spent:,.2f} already submitted in this run. Stopped; rerun resumes the rest."
                )
            batch = self.client.messages.batches.create(
                requests=[{"custom_id": k, "params": requests[k]} for k in chunk]
            )
            self.state.batches.append(
                {
                    "batch_id": batch.id,
                    "kind": self.kind,
                    "model": self.model,
                    "prompt_version": self.prompt_version,
                    "submitted_at": utc_now().isoformat(),
                    "n": len(chunk),
                    "keys": chunk,
                    "est_usd": round(chunk_usd, 6),
                    "status": "in_progress",
                    "actual_usd": None,
                }
            )
            self.state.save()
            spent += chunk_usd
            submitted.append(batch.id)
            log.info("submitted batch %s: %d requests, ~$%.2f", batch.id, len(chunk), chunk_usd)
        return submitted

    def status(self) -> list[dict[str, Any]]:
        return [{k: v for k, v in b.items() if k != "keys"} for b in self.state.batches]
