"""Name, website, phone and address keys used by the entity-resolution stage.

Everything here is a plain function so it can be unit tested, and match.py registers the ones it needs
as DuckDB UDFs. The similarity itself (Jaro-Winkler and a token-set measure) is computed in SQL on these
keys; `name_similarity` is the same formula in Python and is what the unit tests check.

Names are never split on assumed word boundaries: Latin text is split on spaces, while Han, kana,
Hangul and Thai runs (which have no spaces between words) become character bigrams.
"""

from __future__ import annotations

import re
import unicodedata
from urllib.parse import urlsplit

# Scripts written without spaces between words: compared as character bigrams.
_NO_SPACE_RANGES = (
    (0x3040, 0x30FF),  # hiragana, katakana
    (0x3400, 0x4DBF),  # CJK extension A
    (0x4E00, 0x9FFF),  # CJK unified ideographs
    (0xF900, 0xFAFF),  # compatibility ideographs
    (0xAC00, 0xD7AF),  # Hangul syllables
    (0x0E00, 0x0E7F),  # Thai
    (0x0E80, 0x0EFF),  # Lao
    (0x1780, 0x17FF),  # Khmer
    (0x20000, 0x2FA1F),  # CJK extensions B and later
)
_LATIN_FIXES = {"đ": "d", "ø": "o", "ł": "l", "ß": "ss", "æ": "ae", "œ": "oe"}
# Words that carry no identity ("the", "of"); category words stay, so "Tokyo Tower" and "Tokyo Skytree"
# keep different tokens.
STOPWORDS = frozenset({"the", "of", "and", "a", "an", "de", "la", "le", "du", "di", "da", "no", "at"})


def _no_space_script(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in _NO_SPACE_RANGES)


def _is_latin_base(ch: str) -> bool:
    return ch.isalpha() and unicodedata.name(ch, "").startswith(("LATIN", "DIGIT"))


def name_key(value: str | None) -> str | None:
    """A comparison key: NFKC, case-folded, accents removed from Latin letters only, punctuation as space.

    Kana voicing marks and Thai vowel signs are kept (dropping them would merge different words), so
    "が" stays distinct from "か".
    """
    if not value:
        return None
    text = unicodedata.normalize("NFKC", value).casefold()
    for src, dst in _LATIN_FIXES.items():
        text = text.replace(src, dst)
    decomposed = unicodedata.normalize("NFD", text)
    kept: list[str] = []
    base_is_latin = False
    for ch in decomposed:
        cat = unicodedata.category(ch)
        if cat == "Mn":
            if base_is_latin:
                continue
            kept.append(ch)
            continue
        base_is_latin = _is_latin_base(ch)
        if cat[0] in "LNM":
            kept.append(ch)
        else:  # punctuation, symbols, separators, controls
            kept.append(" ")
    out = unicodedata.normalize("NFC", "".join(kept))
    out = re.sub(r"\s+", " ", out).strip()
    return out or None


def _word_tokens(word: str) -> list[str]:
    """Split one space-free word into runs: Latin text stays whole, no-space scripts become bigrams."""
    tokens: list[str] = []
    latin = ""
    run = ""
    for ch in word:
        if _no_space_script(ch):
            if latin:
                tokens.append(latin)
                latin = ""
            run += ch
        else:
            if run:
                tokens.extend(_bigrams(run))
                run = ""
            latin += ch
    if latin:
        tokens.append(latin)
    if run:
        tokens.extend(_bigrams(run))
    return tokens


def _bigrams(run: str) -> list[str]:
    return [run] if len(run) == 1 else [run[i : i + 2] for i in range(len(run) - 1)]


def name_tokens(key: str | None) -> list[str]:
    """Tokens of a name key: words for spaced scripts, character bigrams for runs of Han/kana/Hangul/Thai."""
    if not key:
        return []
    seen: dict[str, None] = {}
    for word in key.split(" "):
        for token in _word_tokens(word):
            if token not in STOPWORDS:
                seen[token] = None
    return list(seen)


def jaro_winkler(a: str, b: str) -> float:
    """Jaro-Winkler similarity (prefix scale 0.1, up to 4 characters), the same as DuckDB's."""
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    if not la or not lb:
        return 0.0
    window = max(max(la, lb) // 2 - 1, 0)
    ma, mb = [False] * la, [False] * lb
    matches = 0
    for i, ca in enumerate(a):
        for j in range(max(0, i - window), min(lb, i + window + 1)):
            if not mb[j] and b[j] == ca:
                ma[i] = mb[j] = True
                matches += 1
                break
    if not matches:
        return 0.0
    transpositions = 0
    j = 0
    for i in range(la):
        if ma[i]:
            while not mb[j]:
                j += 1
            if a[i] != b[j]:
                transpositions += 1
            j += 1
    jaro = (matches / la + matches / lb + (matches - transpositions / 2) / matches) / 3
    prefix = 0
    for ca, cb in zip(a[:4], b[:4], strict=False):
        if ca != cb:
            break
        prefix += 1
    return jaro + prefix * 0.1 * (1 - jaro)


def token_set_similarity(ta: list[str], tb: list[str]) -> float:
    """Length-weighted Dice over token sets: 2 * weight(shared) / (weight(a) + weight(b))."""
    sa, sb = set(ta), set(tb)
    if not sa or not sb:
        return 0.0
    shared = sum(len(t) for t in sa & sb)
    return 2 * shared / (sum(len(t) for t in sa) + sum(len(t) for t in sb))


def name_similarity(a: str | None, b: str | None) -> float:
    """Similarity of two names in [0, 1]: the better of Jaro-Winkler and the token-set measure.

    Very short keys (two characters or fewer, common for Chinese and Japanese names) are only equal or
    an exact prefix of the other; fuzzy matching on two characters is noise.
    """
    ka, kb = name_key(a), name_key(b)
    return key_similarity(ka, kb)


def key_similarity(ka: str | None, kb: str | None) -> float:
    if not ka or not kb:
        return 0.0
    if ka == kb:
        return 1.0
    if min(len(ka), len(kb)) <= 2:
        longer, shorter = (ka, kb) if len(ka) >= len(kb) else (kb, ka)
        return 0.8 if longer.startswith(shorter) else 0.0
    return max(jaro_winkler(ka, kb), token_set_similarity(name_tokens(ka), name_tokens(kb)))


# Hosts where many places share the same address: the first path segment identifies the page.
SHARED_HOSTS = (
    "facebook.com",
    "instagram.com",
    "twitter.com",
    "x.com",
    "line.me",
    "tabelog.com",
    "tripadvisor.",
    "booking.com",
    "agoda.com",
    "google.",
    "goo.gl",
    "wikipedia.org",
    "youtube.com",
    "ameblo.jp",
    "gnavi.co.jp",
    "hotpepper.jp",
    "retty.me",
    "yelp.",
    "foursquare.com",
    "linktr.ee",
    "wixsite.com",
    "business.site",
    "weebly.com",
    "blogspot.",
    "naver.com",
    "kakao.com",
    "weibo.com",
    "dianping.com",
    "meituan.com",
)


def website_key(url: str | None) -> str | None:
    """The host (without www.) of a website, plus the first path segment for shared hosts."""
    if not url:
        return None
    text = url.strip()
    if "//" not in text:
        text = "//" + text
    try:
        parts = urlsplit(text)
    except ValueError:
        return None
    host = (parts.hostname or "").lower().removeprefix("www.")
    if "." not in host:
        return None
    if any(h in host for h in SHARED_HOSTS):
        segment = next((s for s in parts.path.split("/") if s), "")
        return f"{host}/{segment.lower()}" if segment else None
    return host


def phone_key(value: str | None) -> str | None:
    """The last 8 digits of a phone number (enough to identify a line without country-code variants)."""
    if not value:
        return None
    digits = re.sub(r"\D", "", value)
    return digits[-8:] if len(digits) >= 7 else None


def address_key(value: str | None) -> str | None:
    """A loose address key: the key of the first 40 characters, used only for exact equality."""
    key = name_key(value)
    return key[:40] if key and len(key) >= 8 else None
