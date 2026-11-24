"""Cost estimate before anything is submitted.

With a client, input tokens come from the token counting endpoint (free, exact for the model) on a sample
of the real requests, extrapolated to all of them. Without one (--offline), a character-based heuristic
gives an approximate figure. Output tokens are an assumption (there is nothing to count before the model
answers); calibrate it from an eval run, which prints the measured average.
"""

from __future__ import annotations

import json
import unicodedata
from dataclasses import asdict, dataclass
from typing import Any

from .pricing import BATCH_DISCOUNT, CACHE_WRITE_1H_MULTIPLIER, price_for
from .prompt import count_params

# Haiku 5.5 at low effort: about 120 tokens of JSON plus a short think. 350 leaves headroom.
DEFAULT_OUTPUT_TOKENS = 350
DEFAULT_SAMPLE = 40


class BudgetExceededError(Exception):
    """The estimate is over the cap. Nothing was submitted."""


@dataclass
class Estimate:
    model: str
    n_requests: int
    method: str  # "count_tokens" or "heuristic"
    sampled: int
    avg_input_tokens: float
    prefix_tokens: float
    avg_output_tokens: float
    max_output_tokens: int
    input_usd: float
    output_usd: float
    total_usd: float  # what the budget guard compares: no cache discount, so it is an upper-ish figure
    with_cache_usd: float  # same, if the shared prefix is served from the prompt cache
    worst_case_usd: float  # every request uses its whole max_tokens

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)

    def render(self, budget_usd: float | None = None) -> str:
        approx = "approximate (character heuristic, run without --offline for exact counts)"
        method = "token counting on a sample" if self.method == "count_tokens" else approx
        lines = [
            f"Estimate for {self.n_requests:,} requests on {self.model} (Batch API, 50% off):",
            f"  input tokens   {self.avg_input_tokens:,.0f} per request "
            f"({self.prefix_tokens:,.0f} of them the shared, cacheable prompt) via {method}",
            f"  output tokens  {self.avg_output_tokens:,.0f} per request (assumed; cap {self.max_output_tokens:,})",
            f"  input cost     ${self.input_usd:,.2f}",
            f"  output cost    ${self.output_usd:,.2f}",
            f"  TOTAL          ${self.total_usd:,.2f}   (${self.with_cache_usd:,.2f} if the shared prompt is cache-read; "
            f"worst case ${self.worst_case_usd:,.2f} if every answer hits the output cap)",
        ]
        if budget_usd is not None:
            state = "within" if self.total_usd <= budget_usd else "OVER"
            lines.append(f"  budget         ${budget_usd:,.2f} (ENRICH_BUDGET_USD): {state}")
        return "\n".join(lines)


def heuristic_tokens(text: str) -> float:
    """Rough token count without a tokenizer: ~3.5 characters per token for Latin text, about one token
    per CJK, Hangul, Thai or Khmer character, plus 15% since current tokenizers run higher than older ones."""
    total = 0.0
    for ch in text:
        if ch.isascii():
            total += 1 / 3.5
        elif unicodedata.category(ch).startswith("L") and ord(ch) >= 0x0E00:
            total += 1.0
        else:
            total += 1 / 2.5
    return total * 1.15


def _heuristic_input(params: dict[str, Any]) -> tuple[float, float]:
    system = "".join(b["text"] for b in params["system"])
    schema = json.dumps(params["output_config"]["format"]["schema"], ensure_ascii=False)
    prefix = heuristic_tokens(system + schema)
    message = "".join(m["content"] for m in params["messages"])
    return prefix + heuristic_tokens(message), prefix


def _sample(params_list: list[dict[str, Any]], size: int) -> list[dict[str, Any]]:
    if len(params_list) <= size:
        return params_list
    step = len(params_list) / size
    return [params_list[int(i * step)] for i in range(size)]


def estimate_requests(
    params_list: list[dict[str, Any]],
    model: str,
    *,
    client: Any | None,
    output_tokens: int = DEFAULT_OUTPUT_TOKENS,
    sample_size: int = DEFAULT_SAMPLE,
    extrapolate_to: int | None = None,
) -> Estimate:
    """Estimate the cost of sending params_list (or extrapolate_to requests like them)."""
    if not params_list:
        return Estimate(model, 0, "count_tokens" if client else "heuristic", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    price = price_for(model)
    sample = _sample(params_list, sample_size)
    if client is not None:
        counts = [client.messages.count_tokens(**count_params(p)).input_tokens for p in sample]
        avg_in = sum(counts) / len(counts)
        base = dict(count_params(sample[0]), messages=[{"role": "user", "content": "x"}])
        prefix = float(client.messages.count_tokens(**base).input_tokens)
        method = "count_tokens"
    else:
        pairs = [_heuristic_input(p) for p in sample]
        avg_in = sum(t for t, _ in pairs) / len(pairs)
        prefix = pairs[0][1]
        method = "heuristic"
    n = extrapolate_to or len(params_list)
    max_out = int(params_list[0].get("max_tokens", output_tokens))
    scale = BATCH_DISCOUNT / 1_000_000
    input_usd = n * avg_in * price.input * scale
    output_usd = n * output_tokens * price.output * scale
    variable = max(avg_in - prefix, 0.0)
    with_cache = (
        n * variable * price.input
        + n * prefix * price.cache_read
        + prefix * price.input * CACHE_WRITE_1H_MULTIPLIER
    ) * scale + output_usd
    worst = (n * avg_in * price.input + n * max_out * price.output) * scale
    return Estimate(
        model=model,
        n_requests=n,
        method=method,
        sampled=len(sample),
        avg_input_tokens=avg_in,
        prefix_tokens=prefix,
        avg_output_tokens=float(output_tokens),
        max_output_tokens=max_out,
        input_usd=input_usd,
        output_usd=output_usd,
        total_usd=input_usd + output_usd,
        with_cache_usd=with_cache,
        worst_case_usd=worst,
    )


def check_budget(estimate: Estimate, budget_usd: float) -> None:
    if estimate.total_usd > budget_usd:
        raise BudgetExceededError(
            f"Estimated ${estimate.total_usd:,.2f} is over the ${budget_usd:,.2f} cap (ENRICH_BUDGET_USD / "
            f"--budget-usd). Nothing was submitted. Raise the cap on purpose to go ahead, or enrich fewer places."
        )
