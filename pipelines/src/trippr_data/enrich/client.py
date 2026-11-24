"""The Anthropic client. The key comes from ANTHROPIC_API_KEY in the environment, never from a file."""

from __future__ import annotations

import os
from typing import Any


class MissingApiKeyError(Exception):
    """ANTHROPIC_API_KEY is not set."""


def make_client() -> Any:
    if not (os.environ.get("ANTHROPIC_API_KEY") or "").strip():
        raise MissingApiKeyError(
            "ANTHROPIC_API_KEY is not set. Export it (it is read from the environment only), or use "
            "--dry-run --offline to estimate the cost without calling the API."
        )
    import anthropic

    return anthropic.Anthropic(max_retries=4)
