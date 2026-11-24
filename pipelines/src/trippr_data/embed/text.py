"""The text that is embedded for a place: "name · category · city · summary · Wikivoyage text".

Names come first and in every script the place has ("渋谷スカイ / Shibuya Sky"), so a query in either
script lands on it. The category and city are written as words (the taxonomy label, the city name),
not codes, because that is how people search. `TEXT_VERSION` is part of the cache key: change the
template and bump it, and every vector is recomputed.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from ..cities import load_cities
from ..names import normalize_name
from ..taxonomy import load_taxonomy
from .inputs import PlaceRow

TEXT_VERSION = "v1"
SEPARATOR = " · "
MAX_DESCRIPTION_CHARS = 600
MAX_SUMMARY_CHARS = 300


def label_lookups() -> tuple[dict[str, str], dict[str, str]]:
    """(category -> label, city code -> city name) from the taxonomy and the seed."""
    categories = {key: cat.label for key, cat in load_taxonomy().items()}
    cities = {c.code: c.name for c in load_cities()}
    return categories, cities


def _clip(value: str, limit: int) -> str:
    value = " ".join(value.split())
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def _names(place: PlaceRow) -> str:
    """The name in each script it is known by, without repeats ("Shibuya Sky" == "SHIBUYA SKY")."""
    seen: set[str] = set()
    names: list[str] = []
    for value in (place.name, place.name_local, place.name_en):
        cleaned = normalize_name(value)
        if cleaned and cleaned.casefold() not in seen:
            seen.add(cleaned.casefold())
            names.append(cleaned)
    return " / ".join(names)


def build_text(
    place: PlaceRow,
    *,
    categories: Mapping[str, str] | None = None,
    cities: Mapping[str, str] | None = None,
) -> str:
    """The embedding text for one place. Empty parts are left out."""
    category = (categories or {}).get(place.category, place.category.replace("_", " "))
    city = (cities or {}).get(place.city, place.city)
    parts = [
        _names(place),
        category,
        city,
        _clip(place.summary, MAX_SUMMARY_CHARS),
        _clip(place.description, MAX_DESCRIPTION_CHARS),
    ]
    return SEPARATOR.join(p for p in parts if p)


def build_texts(places: Sequence[PlaceRow]) -> list[str]:
    categories, cities = label_lookups()
    return [build_text(p, categories=categories, cities=cities) for p in places]
