"""Wikivoyage listings from the English monthly dump (no live scraping).

Steps:
1. Download enwikivoyage-latest-pages-articles.xml.bz2 (about 130 MB) once into
   <out>/downloads/wikivoyage/<dump date>/ and check it against the published sha1.
2. Stream the XML and pull the listing templates out of each article: {{see}}, {{do}}, {{eat}},
   {{drink}}, {{sleep}}, {{buy}} and {{listing|type=...}} with name, alt, url, address, lat, long,
   phone, hours, wikidata, wikipedia, lastedit and content.
3. Assign each listing to a Trippr city by its coordinates (inside the city's bounding box here; staging
   keeps it only inside the circle). Listings with no coordinates inside an article whose title is a
   Trippr city (or one of its districts, "Tokyo/Shibuya") are kept in that city's file with NULL
   coordinates and counted; staging cannot place them, so it drops and reports them.

The `content` text is CC BY-SA 4.0 (the licence of Wikivoyage); it stays in its own column and is
flagged as such when staged. Licence checked 2026-11-22: https://en.wikivoyage.org/wiki/Wikivoyage:Copyleft
and https://dumps.wikimedia.org/legal.html.
"""

from __future__ import annotations

import bz2
import hashlib
import json
import logging
import re
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..cities import City
from ..duck import connect, sql_str
from ..layout import raw_dir
from ..registry import Registry
from .common import ExtractRun
from .http import USER_AGENT, PoliteClient

log = logging.getLogger(__name__)

SOURCE = "wikivoyage"
DUMP_BASE = "https://dumps.wikimedia.org/enwikivoyage"
DUMP_FILE = "enwikivoyage-latest-pages-articles.xml.bz2"
LISTING_TYPES = ("see", "do", "eat", "drink", "sleep", "buy", "listing")
FIELDS = (
    "name",
    "alt",
    "url",
    "address",
    "lat",
    "long",
    "phone",
    "hours",
    "wikidata",
    "wikipedia",
    "lastedit",
    "content",
)
QID_RE = re.compile(r"^Q[1-9]\d*$")


@dataclass
class Listing:
    page_id: int
    article: str
    revision: str | None
    listing_type: str
    index: int
    fields: dict[str, str] = field(default_factory=dict)


# ---------------------------------------------------------------------------------------------
# Wikitext parsing
# ---------------------------------------------------------------------------------------------


def iter_templates(text: str) -> Iterator[str]:
    """Top-level `{{...}}` blocks of a wikitext, respecting nesting."""
    depth = 0
    start = 0
    i = 0
    n = len(text)
    while i < n:
        two = text[i : i + 2]
        if two == "{{":
            if depth == 0:
                start = i
            depth += 1
            i += 2
        elif two == "}}" and depth > 0:
            depth -= 1
            i += 2
            if depth == 0:
                yield text[start:i]
        else:
            i += 1


def split_params(body: str) -> list[str]:
    """Split a template body on `|` at depth zero (not inside {{ }} or [[ ]])."""
    parts, buf = [], []
    curly = square = 0
    i = 0
    while i < len(body):
        two = body[i : i + 2]
        if two == "{{":
            curly += 1
            buf.append(two)
            i += 2
        elif two == "}}":
            curly = max(curly - 1, 0)
            buf.append(two)
            i += 2
        elif two == "[[":
            square += 1
            buf.append(two)
            i += 2
        elif two == "]]":
            square = max(square - 1, 0)
            buf.append(two)
            i += 2
        elif body[i] == "|" and curly == 0 and square == 0:
            parts.append("".join(buf))
            buf = []
            i += 1
        else:
            buf.append(body[i])
            i += 1
    parts.append("".join(buf))
    return parts


_COMMENT = re.compile(r"<!--.*?-->", re.S)
_REF = re.compile(r"<ref[^>]*?/>|<ref[^>]*>.*?</ref>", re.S)
_TAG = re.compile(r"</?[a-zA-Z][^>]*>")
_WIKILINK = re.compile(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]")
_EXTLINK = re.compile(r"\[(?:https?:)?//\S+\s+([^\]]+)\]")
_BARELINK = re.compile(r"\[(?:https?:)?//\S+\]")
_BOLD_ITALIC = re.compile(r"'{2,5}")
_INNER_TEMPLATE = re.compile(r"\{\{[^{}]*\}\}")
_SPACES = re.compile(r"\s+")


def clean_text(value: str | None) -> str | None:
    """Plain text from wikitext: links to their label, markup, comments, refs and templates removed."""
    if value is None:
        return None
    text = _COMMENT.sub("", value)
    text = _REF.sub("", text)
    for _ in range(3):  # nested templates, innermost first
        text = _INNER_TEMPLATE.sub("", text)
    text = _WIKILINK.sub(r"\1", text)
    text = _EXTLINK.sub(r"\1", text)
    text = _BARELINK.sub("", text)
    text = _TAG.sub(" ", text)
    text = _BOLD_ITALIC.sub("", text)
    text = _SPACES.sub(" ", text).strip()
    return text or None


def parse_listing(template: str) -> tuple[str, dict[str, str]] | None:
    """(listing type, fields) from one template block, or None when it is not a listing."""
    body = template[2:-2]
    parts = split_params(body)
    name = parts[0].strip().lower().replace("_", " ")
    named: dict[str, str] = {}
    for part in parts[1:]:
        key, sep, value = part.partition("=")
        if sep and re.fullmatch(r"[A-Za-z][A-Za-z _-]*", key.strip()):
            named[key.strip().lower().replace(" ", "")] = value.strip()
    if name in LISTING_TYPES:
        listing_type = named.get("type", "listing").lower() if name == "listing" else name
        if listing_type not in LISTING_TYPES[:-1]:
            listing_type = "listing"
        return listing_type, named
    return None


def _number(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return float(value.strip().replace(",", "."))
    except ValueError:
        return None


def normalise_fields(named: dict[str, str]) -> dict[str, Any]:
    """Typed, cleaned fields of one listing (plain text everywhere; content keeps wikitext-free text)."""
    lat, lon = _number(named.get("lat")), _number(named.get("long") or named.get("lon"))
    if lat is not None and lon is not None and not (-90 <= lat <= 90 and -180 <= lon <= 180):
        lat = lon = None
    if lat is None or lon is None:
        lat = lon = None
    qid = (named.get("wikidata") or "").strip()
    return {
        "name": clean_text(named.get("name")),
        "alt": clean_text(named.get("alt")),
        "url": (named.get("url") or "").strip() or None,
        "address": clean_text(named.get("address")),
        "lat": lat,
        "lon": lon,
        "phone": clean_text(named.get("phone")),
        "hours": clean_text(named.get("hours")),
        "wikidata": qid if QID_RE.match(qid) else None,
        "wikipedia": (named.get("wikipedia") or "").strip() or None,
        "last_edit": (named.get("lastedit") or "").strip() or None,
        "content": clean_text(named.get("content")),
    }


def listings_in_page(page_id: int, title: str, revision: str | None, text: str) -> list[dict[str, Any]]:
    found = []
    seen: set[tuple] = set()
    for idx, template in enumerate(iter_templates(text)):
        parsed = parse_listing(template)
        if not parsed:
            continue
        listing_type, named = parsed
        fields = normalise_fields(named)
        if not fields["name"]:
            continue
        key = (fields["name"], fields["lat"], fields["lon"], listing_type)
        if key in seen:
            continue
        seen.add(key)
        found.append(
            {
                "page_id": page_id,
                "article": title,
                "revision": revision,
                "listing_type": listing_type,
                "listing_index": idx,
                **fields,
            }
        )
    return found


def listing_id(row: dict[str, Any]) -> str:
    digest = hashlib.sha1(
        f"{row['listing_type']}|{row['name']}|{row['lat']}|{row['lon']}".encode()
    ).hexdigest()[:10]
    return f"{row['page_id']}:{digest}"


# ---------------------------------------------------------------------------------------------
# The dump
# ---------------------------------------------------------------------------------------------


def iter_pages(dump: Path) -> Iterator[tuple[int, str, str | None, str]]:
    """(page id, title, revision timestamp, wikitext) for article-namespace, non-redirect pages."""
    with bz2.open(dump, "rb") as fh:
        for _, elem in ET.iterparse(fh, events=("end",)):
            if not elem.tag.endswith("}page") and elem.tag != "page":
                continue
            ns = elem.find("{*}ns")
            if ns is not None and ns.text == "0" and elem.find("{*}redirect") is None:
                rev = elem.find("{*}revision")
                text = rev.findtext("{*}text") if rev is not None else None
                if text and "{{" in text:
                    yield (
                        int(elem.findtext("{*}id") or 0),
                        elem.findtext("{*}title") or "",
                        rev.findtext("{*}timestamp") if rev is not None else None,
                        text,
                    )
            elem.clear()


def city_keys(cities: list[City]) -> dict[str, str]:
    """Lower-case article names that stand for a city: 'Tokyo' and its districts 'Tokyo/Shibuya'."""
    keys: dict[str, str] = {}
    for c in cities:
        base = c.name.lower()
        keys.setdefault(base, c.code)
        stripped = re.sub(r"\s*\(.*?\)", "", base).strip()
        keys.setdefault(stripped, c.code)
        for inner in re.findall(r"\((.*?)\)", base):
            keys.setdefault(inner.strip(), c.code)
    return keys


def article_city(title: str, keys: dict[str, str]) -> str | None:
    return keys.get(title.split("/", 1)[0].strip().lower())


def sha1_file(path: Path) -> str:
    digest = hashlib.sha1()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def dump_date_of(client: PoliteClient, url: str) -> str:
    """The dump's date (YYYYMMDD) from the Last-Modified header of the 'latest' link."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": client.user_agent})
    with urllib.request.urlopen(req, timeout=60) as resp:
        modified = resp.headers.get("Last-Modified", "")
    match = re.search(r"(\d{1,2}) (\w{3}) (\d{4})", modified)
    if not match:
        return "unknown"
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return f"{match.group(3)}{months.index(match.group(2)) + 1:02d}{int(match.group(1)):02d}"


def download(url: str, dest: Path, user_agent: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": user_agent})
    started = time.monotonic()
    with urllib.request.urlopen(req, timeout=120) as resp, open(part, "wb") as fh:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(1 << 20):
            fh.write(chunk)
            done += len(chunk)
            if done % (32 << 20) < (1 << 20):
                log.info("wikivoyage dump: %d / %d MB", done >> 20, total >> 20)
    part.replace(dest)
    log.info(
        "downloaded %s (%d MB) in %.0fs", dest.name, dest.stat().st_size >> 20, time.monotonic() - started
    )


def fetch_dump(out: Path, client: PoliteClient) -> tuple[Path, dict[str, Any]]:
    """The dump file (downloaded when missing) and facts about it."""
    latest_url = f"{DUMP_BASE}/latest/{DUMP_FILE}"
    stamp = dump_date_of(client, latest_url)
    folder = out / "downloads" / "wikivoyage" / stamp
    path = folder / DUMP_FILE
    sha_expected = None
    try:
        sums = client.request(f"{DUMP_BASE}/{stamp}/enwikivoyage-{stamp}-sha1sums.txt").decode()
        for line in sums.splitlines():
            digest, _, name = line.partition("  ")
            if name.strip() == f"enwikivoyage-{stamp}-pages-articles.xml.bz2":
                sha_expected = digest.strip()
    except Exception as err:  # the sums file is a nicety; the download is verified when it exists
        log.warning("no sha1sums for the dump (%s)", err)
    if not path.is_file():
        download(f"{DUMP_BASE}/{stamp}/enwikivoyage-{stamp}-pages-articles.xml.bz2", path, client.user_agent)
    sha = sha1_file(path)
    if sha_expected and sha != sha_expected:
        path.unlink()
        raise RuntimeError(f"Wikivoyage dump {stamp} failed its sha1 check; deleted, run again")
    return path, {
        "dump_date": stamp,
        "dump_url": f"{DUMP_BASE}/{stamp}/",
        "dump_bytes": path.stat().st_size,
        "dump_sha1": sha,
        "dump_sha1_verified": bool(sha_expected),
    }


def extract(
    cities: list[City],
    *,
    out: Path,
    date: str,
    registry: Registry,
    dump: Path | None = None,
    client: PoliteClient | None = None,
) -> dict[str, Any]:
    entry = registry.require(SOURCE)
    client = client or PoliteClient(min_interval=2.0, timeout=120)
    facts: dict[str, Any]
    if dump is None:
        dump, facts = fetch_dump(out, client)
    else:
        facts = {"dump_date": "local", "dump_bytes": dump.stat().st_size, "dump_sha1": sha1_file(dump)}
    job = ExtractRun(
        source=SOURCE,
        entry=entry,
        out=out,
        date=date,
        version=f"enwikivoyage-{facts['dump_date']}",
        dataset_path=f"{DUMP_BASE}/{facts['dump_date']}/",
        query_template="listing templates {{see|do|eat|drink|sleep|buy|listing}} in namespace 0, "
        "coordinates inside <min_lon> <min_lat> <max_lon> <max_lat>",
        extra={**facts, "user_agent": USER_AGENT, "content_licence": "CC-BY-SA-4.0"},
    )
    keys = city_keys(cities)
    by_city: dict[str, list[dict[str, Any]]] = {c.code: [] for c in cities}
    pages = listings_total = 0
    started = time.monotonic()
    for page_id, title, revision, text in iter_pages(dump):
        pages += 1
        article_code = article_city(title, keys)
        for row in listings_in_page(page_id, title, revision, text):
            listings_total += 1
            row["article_city"] = article_code
            if row["lat"] is not None:
                for c in cities:
                    min_lon, min_lat, max_lon, max_lat = c.bbox
                    if min_lat <= row["lat"] <= max_lat and min_lon <= row["lon"] <= max_lon:
                        by_city[c.code].append(row)
            elif article_code in by_city:
                by_city[article_code].append(row)
    log.info(
        "wikivoyage: %d pages with templates, %d listings, %.0fs",
        pages,
        listings_total,
        time.monotonic() - started,
    )
    con = connect()
    files: dict[str, dict[str, Any]] = {}
    directory = raw_dir(out, SOURCE, date)
    for city in cities:
        target = directory / f"{city.code}.parquet"
        write_city_rows(con, by_city[city.code], target)
        info = job.file_info(con, city, target)
        info["listings_without_coordinates"] = sum(1 for r in by_city[city.code] if r["lat"] is None)
        files[f"{city.code}.parquet"] = info
    con.close()
    return job.write_meta(files) | {"pages_with_templates": pages, "listings_total": listings_total}


def write_city_rows(con: Any, rows_: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    nd = path.with_suffix(".ndjson.tmp")
    for r in rows_:
        r["source_id"] = listing_id(r)
    nd.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows_) + "\n", encoding="utf-8", newline="\n"
    )
    con.execute(
        f"COPY (SELECT * FROM read_json({sql_str(nd.as_posix())}, format = 'newline_delimited', columns = "
        "{source_id: 'VARCHAR', page_id: 'BIGINT', article: 'VARCHAR', article_city: 'VARCHAR', "
        "revision: 'VARCHAR', listing_type: 'VARCHAR', listing_index: 'INTEGER', name: 'VARCHAR', "
        "alt: 'VARCHAR', url: 'VARCHAR', address: 'VARCHAR', lat: 'DOUBLE', lon: 'DOUBLE', "
        "phone: 'VARCHAR', hours: 'VARCHAR', wikidata: 'VARCHAR', wikipedia: 'VARCHAR', "
        "last_edit: 'VARCHAR', content: 'VARCHAR'}) ORDER BY source_id) "
        f"TO {sql_str(path.as_posix())} (FORMAT parquet, COMPRESSION zstd)"
    ).fetchall()
    nd.unlink(missing_ok=True)
