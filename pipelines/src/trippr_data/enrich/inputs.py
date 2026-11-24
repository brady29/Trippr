"""What enrichment reads: one curated place's golden-record fields and its source description.

This module is the one place that names the input columns. It reads the curate stage's
`curated/<date>/curated_place.parquet`, a bundle's `places.parquet` or `places.jsonl.gz`, or any
Parquet / JSON lines with the same names. If a later schema renames columns, change DEFAULT_COLUMN_MAP
(our name -> its name) or pass --column-map.

| Column | Required | Notes |
|---|---|---|
| place_id | yes | The curated place's stable id (`place_id` in curated_place.parquet, `id` in a bundle). Falls back to `id`, `golden_id`, then "source:source_id" for staged rows |
| name | yes | Primary name |
| name_local, name_en | no | Local-script and English names |
| category | yes | A taxonomy category (config/taxonomy.csv) |
| city_code | yes | A Trippr city code (seed/cities.json) |
| address, opening_hours | no | When the sources have them |
| description | no | The golden record's description: Wikidata or Wikivoyage text. The only prose the model sees |
| sources | no | The sources the golden record merges: a list of names, or of records with a `source` field |
"""

from __future__ import annotations

import gzip
import hashlib
import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..cities import City, load_cities
from ..duck import connect, rows
from ..layout import curated_file, latest_curated_date
from ..taxonomy import Category, load_taxonomy

# Our column name -> the column name in the input file. Edit here when the curated schema differs.
DEFAULT_COLUMN_MAP: dict[str, str] = {}

INPUT_COLUMNS = (
    "place_id",
    "name",
    "name_local",
    "name_en",
    "category",
    "city_code",
    "address",
    "opening_hours",
    "description",
    "sources",
)
# Read when place_id is not there.
ID_FALLBACK_COLUMNS = ("id", "golden_id", "source", "source_id")
REQUIRED_COLUMNS = ("place_id", "name", "category", "city_code")

# Long source text costs tokens on every re-run; the first 1,500 characters carry the facts.
MAX_DESCRIPTION_CHARS = 1500

# Zero-width and byte-order characters that Wikivoyage text carries.
_INVISIBLE = {c: None for c in (0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x2060, 0xFEFF)}
_FILE_MARKUP = re.compile(r"^\s*\d+px\s*\|\s*", re.IGNORECASE)


def default_input(out: Path, date: str | None = None) -> Path:
    """The curate stage's output for a date (default: the newest curated run)."""
    chosen = date or latest_curated_date(out)
    if not chosen:
        raise FileNotFoundError(
            f"No curated places under {out / 'curated'}; run curate first or pass --input"
        )
    return curated_file(out, chosen)


@lru_cache(maxsize=1)
def taxonomy() -> dict[str, Category]:
    return load_taxonomy()


@lru_cache(maxsize=1)
def cities_by_code() -> dict[str, City]:
    return {c.code: c for c in load_cities()}


def _nfc(value: str) -> str:
    return unicodedata.normalize("NFC", value).strip()


def clean_description(text: str) -> str:
    """Drop invisible characters and wiki file markup ("20px|"), collapse whitespace, cap the length."""
    cleaned = unicodedata.normalize("NFC", text).translate(_INVISIBLE)
    cleaned = _FILE_MARKUP.sub("", cleaned)
    return " ".join(cleaned.split())[:MAX_DESCRIPTION_CHARS]


class EnrichInput(BaseModel):
    model_config = ConfigDict(extra="ignore")

    place_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    name_local: str | None = None
    name_en: str | None = None
    category: str
    city_code: str = Field(min_length=1)
    address: str | None = None
    opening_hours: str | None = None
    description: str | None = None
    sources: list[str] = Field(default_factory=list)

    @field_validator("name", "name_local", "name_en", "address", "opening_hours", mode="before")
    @classmethod
    def _text(cls, value: Any) -> Any:
        if value is None:
            return None
        text = " ".join(_nfc(str(value)).split())
        return text or None

    @field_validator("category")
    @classmethod
    def _known_category(cls, value: str) -> str:
        if value not in taxonomy():
            raise ValueError(f"category {value!r} is not in the taxonomy")
        return value

    @field_validator("description", mode="before")
    @classmethod
    def _description(cls, value: Any) -> Any:
        if value is None:
            return None
        return clean_description(str(value)) or None

    @field_validator("sources", mode="before")
    @classmethod
    def _sources(cls, value: Any) -> Any:
        names = {
            str(s.get("source") if isinstance(s, dict) else s).strip() for s in (value or []) if s is not None
        }
        return sorted(n for n in names if n and n != "None")

    # ---- what the model sees -------------------------------------------------------------------

    def content(self) -> dict[str, Any]:
        """Exactly the fields that reach the prompt, in a stable form. Hashing this is the cache key."""
        return {
            "name": self.name,
            "name_local": self.name_local,
            "name_en": self.name_en,
            "category": self.category,
            "city_code": self.city_code,
            "address": self.address,
            "opening_hours": self.opening_hours,
            "description": self.description,
            "sources": list(self.sources),
        }

    def content_hash(self) -> str:
        blob = json.dumps(self.content(), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def label_sources(self) -> list[str]:
        """Sources named in the AI label. With no description the model wrote from the name, category and
        city alone, so no source is named."""
        return list(self.sources) if self.description else []


def apply_column_map(row: dict[str, Any], column_map: dict[str, str]) -> dict[str, Any]:
    out = dict(row)
    for ours, theirs in column_map.items():
        if theirs in row:
            out[ours] = row[theirs]
    return out


def _read_parquet(path: Path, column_map: dict[str, str]) -> list[dict[str, Any]]:
    con = connect()
    source = f"read_parquet('{path.as_posix()}')"
    available = {r["column_name"] for r in rows(con, f"DESCRIBE SELECT * FROM {source}")}
    selects: list[str] = []
    for col in INPUT_COLUMNS:
        theirs = column_map.get(col, col)
        if theirs in available:
            selects.append(f'"{theirs}" AS "{col}"')
    selects += [f'"{c}" AS "{c}"' for c in ID_FALLBACK_COLUMNS if c in available and c not in INPUT_COLUMNS]
    if not selects:
        raise ValueError(f"{path}: none of the enrichment columns {INPUT_COLUMNS} are present")
    return rows(con, f"SELECT {', '.join(selects)} FROM {source}")


def _read_jsonl(path: Path, column_map: dict[str, str]) -> list[dict[str, Any]]:
    opener = gzip.open if path.suffix == ".gz" else open
    out = []
    with opener(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                out.append(apply_column_map(json.loads(line), column_map))
    return out


def _with_place_id(row: dict[str, Any]) -> dict[str, Any]:
    if row.get("place_id"):
        return row
    fallback = row.get("id") or row.get("golden_id")
    if not fallback and row.get("source") and row.get("source_id"):
        fallback = f"{row['source']}:{row['source_id']}"
    return {**row, "place_id": fallback}


def read_places(path: Path, column_map: dict[str, str] | None = None) -> list[EnrichInput]:
    """Read and validate the places to enrich. Raises ValueError listing every bad row's problem."""
    mapping = {**DEFAULT_COLUMN_MAP, **(column_map or {})}
    if not path.is_file():
        raise FileNotFoundError(f"Enrichment input not found: {path}")
    is_json = path.suffix in (".jsonl", ".ndjson") or path.name.endswith((".jsonl.gz", ".ndjson.gz"))
    raw = _read_jsonl(path, mapping) if is_json else _read_parquet(path, mapping)
    places: list[EnrichInput] = []
    problems: list[str] = []
    seen: set[str] = set()
    for i, row in enumerate(map(_with_place_id, raw)):
        missing = [c for c in REQUIRED_COLUMNS if row.get(c) in (None, "")]
        if missing:
            problems.append(f"row {i}: missing {', '.join(missing)}")
            continue
        try:
            place = EnrichInput.model_validate(row)
        except ValueError as err:
            problems.append(f"row {i} ({row.get('place_id')}): {str(err).splitlines()[0]}")
            continue
        if place.place_id in seen:
            problems.append(f"row {i}: duplicate place_id {place.place_id}")
            continue
        seen.add(place.place_id)
        places.append(place)
    if problems:
        shown = "; ".join(problems[:5])
        more = f" (+{len(problems) - 5} more)" if len(problems) > 5 else ""
        raise ValueError(f"{path}: {len(problems)} invalid place(s): {shown}{more}")
    return places


def parse_column_map(items: list[str] | None) -> dict[str, str]:
    """--column-map place_id=golden_id name=display_name"""
    mapping: dict[str, str] = {}
    for item in items or []:
        ours, sep, theirs = item.partition("=")
        if not sep or ours not in INPUT_COLUMNS or not theirs:
            raise ValueError(f"--column-map expects <ours>=<theirs> with ours in {INPUT_COLUMNS}: {item!r}")
        mapping[ours] = theirs
    return mapping
