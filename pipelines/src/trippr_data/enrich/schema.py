"""What the model returns for one place, validated before anything is cached or written."""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, field_validator

from .inputs import taxonomy

BestTime = Literal["morning", "afternoon", "evening", "night", "any"]
PriceLevel = Literal["free", "$", "$$", "$$$"]
GoodFor = Literal["rain", "families", "nightlife", "views"]

BEST_TIMES: tuple[str, ...] = ("morning", "afternoon", "evening", "night", "any")
PRICE_LEVELS: tuple[str, ...] = ("free", "$", "$$", "$$$")
GOOD_FOR: tuple[str, ...] = ("rain", "families", "nightlife", "views")

MAX_SUMMARY_CHARS = 140  # characters (code points), so CJK text gets the same room as English
MAX_TAGS = 4
MIN_DURATION_MIN = 5
MAX_DURATION_MIN = 1440

URL_RE = re.compile(
    r"(?:https?://|www\.)[^\s)\]]+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|jp|cn|kr|io)\b/?[^\s)\]]*", re.I
)


def strip_urls(text: str) -> str:
    """Drop URLs (spec guardrail), then tidy the whitespace and punctuation they leave behind."""
    cleaned = URL_RE.sub("", text)
    cleaned = re.sub(r"\(\s*\)|\[\s*\]", "", cleaned)
    cleaned = re.sub(r"\s+([,.;:!?])", r"\1", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


class Enrichment(BaseModel):
    """One place's enrichment. A field the model could not tell from the input is null or empty."""

    model_config = ConfigDict(extra="forbid")

    tags: list[str]
    summary: str
    duration_min: int | None
    best_time: BestTime | None
    indoor: bool | None
    price_level: PriceLevel | None
    good_for: list[GoodFor]

    @field_validator("tags")
    @classmethod
    def _tags_in_taxonomy(cls, value: list[str]) -> list[str]:
        known = taxonomy()
        unknown = [t for t in value if t not in known]
        if unknown:
            raise ValueError(f"tags not in the taxonomy: {unknown}")
        deduped = list(dict.fromkeys(value))
        if len(deduped) > MAX_TAGS:
            raise ValueError(f"at most {MAX_TAGS} tags, got {len(deduped)}")
        return deduped

    @field_validator("summary")
    @classmethod
    def _one_line_summary(cls, value: str) -> str:
        text = unicodedata.normalize("NFC", value)
        if "�" in text:
            raise ValueError("summary contains the Unicode replacement character (garbled text)")
        if any(unicodedata.category(ch) in ("Cc", "Cs") and ch not in "\n\r\t" for ch in text):
            raise ValueError("summary contains control characters")
        text = strip_urls(text)
        if len(text) > MAX_SUMMARY_CHARS:
            raise ValueError(f"summary is {len(text)} characters; the limit is {MAX_SUMMARY_CHARS}")
        return text

    @field_validator("duration_min")
    @classmethod
    def _duration_range(cls, value: int | None) -> int | None:
        if value is not None and not MIN_DURATION_MIN <= value <= MAX_DURATION_MIN:
            raise ValueError(f"duration_min {value} is outside {MIN_DURATION_MIN}..{MAX_DURATION_MIN}")
        return value

    @field_validator("good_for")
    @classmethod
    def _dedupe_good_for(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(value))


def _nullable(schema: dict[str, Any]) -> dict[str, Any]:
    return {"anyOf": [schema, {"type": "null"}]}


def response_schema() -> dict[str, Any]:
    """The JSON schema sent as output_config.format. It sticks to features structured outputs support
    (enums, anyOf, additionalProperties: false); lengths and ranges are checked by Enrichment."""
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "tags": {"type": "array", "items": {"type": "string", "enum": sorted(taxonomy())}},
            "summary": {"type": "string"},
            "duration_min": _nullable({"type": "integer"}),
            "best_time": _nullable({"type": "string", "enum": list(BEST_TIMES)}),
            "indoor": _nullable({"type": "boolean"}),
            "price_level": _nullable({"type": "string", "enum": list(PRICE_LEVELS)}),
            "good_for": {"type": "array", "items": {"type": "string", "enum": list(GOOD_FOR)}},
        },
        "required": [
            "tags",
            "summary",
            "duration_min",
            "best_time",
            "indoor",
            "price_level",
            "good_for",
        ],
    }
