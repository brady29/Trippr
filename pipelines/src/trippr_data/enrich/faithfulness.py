"""Rule checks on a summary, with no model call: does it only say what the place data says?

This is the free half of the faithfulness rubric. It flags numbers, proper nouns and non-Latin names that
appear in the summary but nowhere in the input (name, category, city, address, description), plus
format problems (URL, length, line breaks, garbled text). It catches invented names and dates and any
mangled CJK, Thai or Hangul name; it cannot catch a plausible claim made only with common words. The
LLM judge (judge.py) covers those, and a person reads a sample.
"""

from __future__ import annotations

import re
import unicodedata

from .inputs import EnrichInput, cities_by_code, taxonomy
from .schema import MAX_SUMMARY_CHARS, URL_RE

JOINERS = "'" + chr(0x2019) + "-"  # apostrophes and hyphen that can sit inside a name
OPENERS = " \"'([" + chr(0x201C) + chr(0x2018)  # what can precede the first word of a sentence

COUNTRY_NAMES = {
    "JP": "Japan",
    "CN": "China",
    "HK": "Hong Kong",
    "MO": "Macau",
    "TW": "Taiwan",
    "KR": "South Korea Korea",
    "VN": "Vietnam",
    "TH": "Thailand",
    "KH": "Cambodia",
    "LA": "Laos",
    "MY": "Malaysia",
    "SG": "Singapore",
    "PH": "Philippines",
    "ID": "Indonesia",
    "BN": "Brunei",
    "MN": "Mongolia",
    "LK": "Sri Lanka",
    "NP": "Nepal",
    "MV": "Maldives",
}

# Capitalised words that are not facts about the place: demonyms and religions a summary may use as
# adjectives, and calendar words.
ALLOWED_WORDS = frozenset(
    [
        "japanese",
        "chinese",
        "korean",
        "thai",
        "vietnamese",
        "lao",
        "laotian",
        "cambodian",
        "khmer",
        "malaysian",
        "indonesian",
        "balinese",
        "javanese",
        "singaporean",
        "taiwanese",
        "filipino",
        "mongolian",
        "nepali",
        "nepalese",
        "sri",
        "lankan",
        "buddhist",
        "shinto",
        "hindu",
        "christian",
        "muslim",
        "taoist",
        "confucian",
        "asian",
        "english",
        "western",
        "eastern",
        "northern",
        "southern",
        "central",
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ]
)


def _fold_latin(text: str) -> str:
    """Case- and accent-insensitive form for Latin text ("Sensō-ji" == "senso-ji")."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def _fold_other(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


def source_text(place: EnrichInput) -> str:
    """Everything the model was shown, as one string (lines joined by a space)."""
    city = cities_by_code().get(place.city_code)
    cat = taxonomy()[place.category]
    parts = [
        place.name,
        place.name_local,
        place.name_en,
        cat.category.replace("_", " "),
        cat.label,
        place.address,
        place.opening_hours,
        city.name if city else place.city_code,
        COUNTRY_NAMES.get(city.country, city.country) if city else None,
        place.description,
    ]
    return " ".join(p for p in parts if p)


def _tokens(text: str) -> list[tuple[str, int]]:
    """(token, start) for runs of letters/marks (with inner ' or - joiners) and for numbers."""
    out: list[tuple[str, int]] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        cat = unicodedata.category(ch)
        if cat[0] in "LM":
            j = i + 1
            while j < n:
                c = unicodedata.category(text[j])[0]
                if c in "LM" or (
                    text[j] in JOINERS and j + 1 < n and unicodedata.category(text[j + 1])[0] == "L"
                ):
                    j += 1
                else:
                    break
            out.append((text[i:j], i))
            i = j
        elif cat == "Nd":
            j = i + 1
            while j < n and (
                unicodedata.category(text[j]) == "Nd"
                or (text[j] in ",.:" and j + 1 < n and text[j + 1].isdigit())
            ):
                j += 1
            out.append((text[i:j], i))
            i = j
        else:
            i += 1
    return out


def _is_latin(token: str) -> bool:
    return all(
        unicodedata.name(c, "").startswith("LATIN") or unicodedata.category(c)[0] in "M" or c in JOINERS
        for c in token
    )


def _sentence_initial(summary: str, start: int) -> bool:
    before = summary[:start].rstrip(OPENERS)
    return not before or before[-1] in ".!?:;"


def unsupported_terms(summary: str, place: EnrichInput, *, is_name: bool = False) -> list[str]:
    """Terms in the summary that the place data does not contain. Empty means nothing was flagged."""
    if not summary:
        return []
    text = source_text(place)
    latin_text, other_text = _fold_latin(text), _fold_other(text)
    flagged: list[str] = []
    for token, start in _tokens(summary):
        if token[0].isdigit():
            if token.rstrip(".,:") not in text:
                flagged.append(token)
        elif _is_latin(token):
            parts = [p for p in re.split("[" + JOINERS + "]", token) if p]
            word = token
            if word.lower().endswith(("'s", chr(0x2019) + "s")):
                word = word[:-2]
            initial = not is_name and _sentence_initial(summary, start)  # a name has no sentence start
            capitalised = token[0].isupper()
            acronym = len(word) >= 2 and word.isupper()
            if not capitalised or (initial and not acronym):
                continue
            if _fold_latin(word) in ALLOWED_WORDS:
                continue
            if (
                all(_fold_latin(p) in latin_text for p in parts if len(p) > 1)
                or _fold_latin(word) in latin_text
            ):
                continue
            flagged.append(token)
        elif len(token) >= 2 and _fold_other(token) not in other_text:
            flagged.append(token)
    return list(dict.fromkeys(flagged))


def format_problems(summary: str) -> list[str]:
    problems = []
    if len(summary) > MAX_SUMMARY_CHARS:
        problems.append("too long")
    if "\n" in summary or "\r" in summary:
        problems.append("line break")
    if URL_RE.search(summary):
        problems.append("url")
    if "�" in summary:
        problems.append("garbled text")
    return problems
