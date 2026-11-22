"""Place name normalisation.

Names keep their own script: Japanese, Chinese, Korean and Thai names stay as written. We only
apply Unicode NFKC (full-width Latin and digits become ASCII, half-width katakana becomes
full-width, the ideographic space becomes a normal space), drop control characters, collapse
whitespace and trim separator punctuation from the ends.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable

# Separators trimmed from either end of a name. Brackets, quotes, "!" and "?" are kept because
# they are often part of the name ("Yahoo!", "(株)").
_EDGE_CHARS = " \t\r\n.,;:·・|/\\-_~、。，；：　"
_WHITESPACE = re.compile(r"\s+")


def normalize_name(value: str | None) -> str | None:
    if value is None:
        return None
    text = unicodedata.normalize("NFKC", value)
    text = "".join(ch for ch in text if unicodedata.category(ch)[0] != "C" or ch in "\t\n")
    text = _WHITESPACE.sub(" ", text).strip(_EDGE_CHARS)
    return text or None


def is_latin(value: str | None) -> bool | None:
    """True when every letter in the text is Latin script (accents allowed), e.g. 'Café Lumière'."""
    if value is None:
        return None
    letters = [ch for ch in value if ch.isalpha()]
    if not letters:
        return False
    return all("LATIN" in unicodedata.name(ch, "") for ch in letters)


def pick_names(
    primary: str | None,
    by_language: Iterable[tuple[str | None, str | None]] = (),
    local_languages: Iterable[str] = (),
) -> tuple[str | None, str | None, str | None]:
    """(name, name_local, name_en) for one place.

    by_language holds (language, value) pairs from the source (Overture's names.rules).
    name_local is the name in one of the country's languages, else the primary name when it is not
    Latin script. name_en is the English name, else the primary name when it is Latin script.
    """
    local_set = set(local_languages)
    pairs = [(lang, normalize_name(text)) for lang, text in by_language if lang and text]
    name = normalize_name(primary)
    english = next((t for lang, t in pairs if t and (lang == "en" or lang.startswith("en-"))), None)
    local = next((t for lang, t in pairs if t and lang in local_set), None)
    if local is None and name is not None and not is_latin(name):
        local = name
    if english is None and name is not None and is_latin(name):
        english = name
    return name, local, english
