"""What a batch costs. Prices are USD per million tokens at standard (non-batch) rates.

Cached 2026-11-03 from the Claude pricing page; confirm there before relying on them for a large run.
Haiku 5.5 is $0.10 / $0.50 for prompts up to 100K tokens (each enrichment request is about 1K).
The Batch API takes 50% off every token. A cache write with the 1 hour TTL costs 2x the input rate and
a cache read 0.1x (Haiku) or 0.05x (Sonnet 5.5).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

BATCH_DISCOUNT = 0.5
CACHE_WRITE_1H_MULTIPLIER = 2.0
PRICES_CHECKED = "2026-11-03"


@dataclass(frozen=True)
class ModelPrice:
    input: float
    output: float
    cache_read: float


PRICES: dict[str, ModelPrice] = {
    "claude-haiku-5-5": ModelPrice(input=0.10, output=0.50, cache_read=0.01),
    "claude-sonnet-5-5": ModelPrice(input=2.00, output=10.00, cache_read=0.10),
}


def price_for(model: str) -> ModelPrice:
    try:
        return PRICES[model]
    except KeyError:
        raise ValueError(
            f"No price on file for model {model!r}; add it to enrich/pricing.py (known: {', '.join(PRICES)})"
        ) from None


def usage_cost(usage: dict[str, Any], model: str) -> float:
    """USD for one batch result's usage block, at batch rates."""
    p = price_for(model)
    standard = (
        (usage.get("input_tokens") or 0) * p.input
        + (usage.get("output_tokens") or 0) * p.output
        + (usage.get("cache_read_input_tokens") or 0) * p.cache_read
        + (usage.get("cache_creation_input_tokens") or 0) * p.input * CACHE_WRITE_1H_MULTIPLIER
    ) / 1_000_000
    return standard * BATCH_DISCOUNT
