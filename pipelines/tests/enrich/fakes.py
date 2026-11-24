"""A fake Anthropic client for the enrichment tests: no network, no key, no spend.

It implements the slice of the SDK the pipeline uses (messages.count_tokens and messages.batches.create,
retrieve and results) with the same attribute shapes, answers each batch request through a `responder`,
and records every call so tests can assert exactly what would have been sent and paid for.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterator
from types import SimpleNamespace
from typing import Any

from trippr_data.enrich.evaluate import EvalPlace
from trippr_data.enrich.inputs import taxonomy

Responder = Callable[[dict[str, Any]], "str | Exception"]


def place_fields(params: dict[str, Any]) -> dict[str, str]:
    """Parse the labelled lines of the user message back into a dict."""
    content = params["messages"][0]["content"]
    fields: dict[str, str] = {}
    for line in content.splitlines():
        m = re.match(r"^([a-z ()A-Z-]+): (.*)$", line)
        if m:
            fields[m.group(1)] = m.group(2)
    return fields


def default_responder(params: dict[str, Any]) -> str:
    """A plausible, schema-valid, faithful answer built from the prompt."""
    fields = place_fields(params)
    slug = fields["category"].split(" ")[0]
    summary = (
        f"{fields['name']} is a place of type {slug.replace('_', ' ')} in {fields['city'].split(',')[0]}."
    )
    return json.dumps(
        {
            "tags": [slug],
            "summary": summary,
            "duration_min": 60,
            "best_time": "any",
            "indoor": None,
            "price_level": None,
            "good_for": [],
        },
        ensure_ascii=False,
    )


def reference_responder(items: list[EvalPlace]) -> Responder:
    """Answers with each eval place's reference labels, so scoring should be perfect."""
    by_name = {i.place.name: i for i in items}

    def respond(params: dict[str, Any]) -> str:
        fields = place_fields(params)
        item = by_name[fields["name"]]
        return json.dumps(
            {
                "tags": item.ref.tags,
                "summary": f"{item.place.name} in {fields['city'].split(',')[0]}.",
                "duration_min": item.ref.duration_min,
                "best_time": item.ref.best_time,
                "indoor": item.ref.indoor,
                "price_level": None,
                "good_for": [],
            },
            ensure_ascii=False,
        )

    return respond


def usage(input_tokens: int = 900, output_tokens: int = 120) -> SimpleNamespace:
    return SimpleNamespace(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_input_tokens=0,
        cache_creation_input_tokens=0,
    )


class FakeBatches:
    def __init__(self, owner: FakeAnthropic):
        self.owner = owner
        self.batches: dict[str, dict[str, Any]] = {}

    def create(self, *, requests: list[dict[str, Any]]) -> SimpleNamespace:
        owner = self.owner
        assert requests, "an empty batch would be rejected by the API"
        for r in requests:
            assert re.fullmatch(r"[A-Za-z0-9_-]{1,64}", r["custom_id"]), r["custom_id"]
            p = r["params"]
            assert "budget_tokens" not in json.dumps(p) and "temperature" not in p
            assert p["system"][0]["cache_control"]["type"] == "ephemeral"
        batch_id = f"msgbatch_fake{len(self.batches) + 1:03d}"
        self.batches[batch_id] = {"requests": requests, "polls": 0}
        owner.created.append(batch_id)
        owner.requests_sent += len(requests)
        return SimpleNamespace(id=batch_id, processing_status="in_progress")

    def retrieve(self, batch_id: str) -> SimpleNamespace:
        batch = self.batches[batch_id]
        batch["polls"] += 1
        ended = batch["polls"] > self.owner.polls_before_ended
        return SimpleNamespace(id=batch_id, processing_status="ended" if ended else "in_progress")

    def results(self, batch_id: str) -> Iterator[SimpleNamespace]:
        for r in self.batches[batch_id]["requests"]:
            answer = self.owner.responder(r["params"])
            if isinstance(answer, Exception):
                yield SimpleNamespace(
                    custom_id=r["custom_id"],
                    result=SimpleNamespace(type="errored", error=SimpleNamespace(type="overloaded_error")),
                )
                continue
            stop = "max_tokens" if answer == "<<max_tokens>>" else "end_turn"
            text = "" if stop == "max_tokens" else answer
            message = SimpleNamespace(
                stop_reason=stop,
                content=[
                    SimpleNamespace(type="thinking", thinking=""),
                    SimpleNamespace(type="text", text=text),
                ],
                usage=usage(output_tokens=self.owner.output_tokens),
            )
            yield SimpleNamespace(
                custom_id=r["custom_id"], result=SimpleNamespace(type="succeeded", message=message)
            )


class FakeMessages:
    def __init__(self, owner: FakeAnthropic):
        self.owner = owner
        self.batches = FakeBatches(owner)

    def count_tokens(self, **kwargs: Any) -> SimpleNamespace:
        self.owner.count_calls += 1
        assert "max_tokens" not in kwargs
        return SimpleNamespace(input_tokens=max(1, len(json.dumps(kwargs, ensure_ascii=False)) // 4))

    def create(self, **kwargs: Any) -> Any:
        raise AssertionError("the pipeline must use the Batch API, never a synchronous call")


class FakeAnthropic:
    def __init__(
        self,
        responder: Responder = default_responder,
        *,
        polls_before_ended: int = 0,
        output_tokens: int = 120,
    ):
        self.responder = responder
        self.polls_before_ended = polls_before_ended
        self.output_tokens = output_tokens
        self.created: list[str] = []
        self.requests_sent = 0
        self.count_calls = 0
        self.messages = FakeMessages(self)


def known_tags() -> set[str]:
    return set(taxonomy())
