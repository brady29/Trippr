"""What enrichment reads: one curated place's golden-record fields and source descriptions.

This module is the one place that names the input columns. Today it reads any Parquet (or JSON lines)
with these columns; once PR 3's curated output exists, point it there by changing DEFAULT_COLUMN_MAP
(our name -> its name) or by passing --column-map on the command line.

| Column | Required | Notes |
|---|---|---|
| place_id | yes | The golden record's id. Falls back to "source:source_id" for staged places |
| name | yes | Primary name |
| name_local, name_en | no | Local-script and English names |
| category | yes | A taxonomy category (config/taxonomy.csv) |
| city_code | yes | A Trippr city code (seed/cities.json) |
| address, opening_hours | no | When the sources have them |
| descriptions | no | List of {source, text}: Wikidata, Wikivoyage or OSM text. The only prose the model sees |
| sources | no | Names of the sources the golden record merges (overture, osm, ...) |
"""

from __future__ import annotations

import hashlib
import json
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..cities import City, load_cities
from ..duck import connect, rows
from ..taxonomy import Category, load_taxonomy

# Where PR 3 is expected to write the curated places for a run (relative to the output root).
DEFAULT_INPUT_TEMPLATE = "curated/{date}/places.parquet"

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
    "descriptions",
    "sources",
)
REQUIRED_COLUMNS = ("place_id", "name", "category", "city_code")

# Long source text costs tokens on every re-run; the first 1,500 characters carry the facts.
MAX_DESCRIPTION_CHARS = 1500
MAX_DESCRIPTIONS = 4


@lru_cache(maxsize=1)
def taxonomy() -> dict[str, Category]:
    return load_taxonomy()


@lru_cache(maxsize=1)
def cities_by_code() -> dict[str, City]:
    return {c.code: c for c in load_cities()}


def _nfc(value: str) -> str:
    return unicodedata.normalize("NFC", value).strip()


class Description(BaseModel):
    model_config = ConfigDict(extra="ignore")

    source: str
    text: str

    @field_validator("source", "text")
    @classmethod
    def _clean(cls, value: str) -> str:
        return _nfc(value)


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
    descriptions: list[Description] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)

    @field_validator("name", "name_local", "name_en", "address", "opening_hours", mode="before")
    @classmethod
    def _text(cls, value: Any) -> Any:
        if value is None:
            return None
        text = _nfc(str(value))
        return text or None

    @field_validator("category")
    @classmethod
    def _known_category(cls, value: str) -> str:
        if value not in taxonomy():
            raise ValueError(f"category {value!r} is not in the taxonomy")
        return value

    @field_validator("descriptions", mode="before")
    @classmethod
    def _descriptions(cls, value: Any) -> Any:
        if value is None:
            return []
        out = []
        for item in value:
            if isinstance(item, str):
                item = {"source": "unknown", "text": item}
            text = _nfc(str(item.get("text") or ""))
            if text:
                out.append({"source": item.get("source") or "unknown", "text": text[:MAX_DESCRIPTION_CHARS]})
        return out[:MAX_DESCRIPTIONS]

    @field_validator("sources", mode="before")
    @classmethod
    def _sources(cls, value: Any) -> Any:
        return sorted({str(s).strip() for s in (value or []) if str(s).strip()})

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
            "descriptions": sorted(
                ({"source": d.source, "text": d.text} for d in self.descriptions),
                key=lambda d: (d["source"], d["text"]),
            ),
            "sources": list(self.sources),
        }

    def content_hash(self) -> str:
        blob = json.dumps(self.content(), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def label_sources(self) -> list[str]:
        """Sources named in the AI label: the ones whose text the model read, else the merged sources."""
        from_text = sorted({d.source for d in self.descriptions if d.source != "unknown"})
        return from_text or list(self.sources)


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
    chosen = {s.split(" AS ")[1].strip('"') for s in selects}
    if "place_id" not in chosen and {"source", "source_id"} <= available:
        selects.append("source || ':' || source_id AS place_id")
    if not selects:
        raise ValueError(f"{path}: none of the enrichment columns {INPUT_COLUMNS} are present")
    return rows(con, f"SELECT {', '.join(selects)} FROM {source}")


def _read_jsonl(path: Path, column_map: dict[str, str]) -> list[dict[str, Any]]:
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                out.append(apply_column_map(json.loads(line), column_map))
    return out


def read_places(path: Path, column_map: dict[str, str] | None = None) -> list[EnrichInput]:
    """Read and validate the places to enrich. Raises ValueError listing every bad row's problem."""
    mapping = {**DEFAULT_COLUMN_MAP, **(column_map or {})}
    if not path.is_file():
        raise FileNotFoundError(f"Enrichment input not found: {path}")
    raw = _read_jsonl(path, mapping) if path.suffix in (".jsonl", ".ndjson") else _read_parquet(path, mapping)
    places: list[EnrichInput] = []
    problems: list[str] = []
    seen: set[str] = set()
    for i, row in enumerate(raw):
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
