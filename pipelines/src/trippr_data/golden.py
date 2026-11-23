"""The golden_place schema: the input of the curate stage.

One golden record per real-world place, produced by the match stage (entity resolution across sources,
docs/data-platform-spec.md "Entity resolution", survivorship). Defined here, in one place, so curate does
not depend on how the match stage stores things: if the match stage writes
`golden/<date>/golden_place.parquet` with these columns, curate reads it as is.

When there is no match output, curate stages each source row as its own golden record
(`provisional.py`), so the rest of the pipeline can run end to end.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from .schema import SIGNALS_TYPE, Signals


class GoldenSource(BaseModel):
    """One source record that backs a golden record. Provenance: kept all the way to the graph."""

    model_config = ConfigDict(extra="forbid")

    source: str
    source_id: str
    licence: str
    fetched_at: datetime
    raw_ref: str


class GoldenPlace(BaseModel):
    model_config = ConfigDict(extra="forbid")

    golden_id: str
    name: str
    name_local: str | None
    name_en: str | None
    category: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    city_code: str
    address: str | None
    website: str | None
    phone: str | None
    opening_hours: str | None
    wikidata_qid: str | None
    description: str | None
    # Merged over the cluster: highest confidence, most Wikidata sitelinks, listed in Wikivoyage in any.
    signals: Signals
    sources: list[GoldenSource] = Field(min_length=1)


GOLDEN_SOURCE_TYPE = (
    "STRUCT(source VARCHAR, source_id VARCHAR, licence VARCHAR, "
    "fetched_at TIMESTAMP WITH TIME ZONE, raw_ref VARCHAR)"
)

# Column order and DuckDB types of golden_place.parquet.
GOLDEN_COLUMNS: dict[str, str] = {
    "golden_id": "VARCHAR",
    "name": "VARCHAR",
    "name_local": "VARCHAR",
    "name_en": "VARCHAR",
    "category": "VARCHAR",
    "lat": "DOUBLE",
    "lon": "DOUBLE",
    "city_code": "VARCHAR",
    "address": "VARCHAR",
    "website": "VARCHAR",
    "phone": "VARCHAR",
    "opening_hours": "VARCHAR",
    "wikidata_qid": "VARCHAR",
    "description": "VARCHAR",
    "signals": SIGNALS_TYPE,
    "sources": f"{GOLDEN_SOURCE_TYPE}[]",
}

assert list(GOLDEN_COLUMNS) == list(GoldenPlace.model_fields), "golden schema drift"

# Which source wins when two records disagree, and which one a place's stable id is built from
# (best first). Matches the spec's survivorship: names from Wikidata/Wikivoyage, coordinates and
# websites from OSM/Overture.
SOURCE_PRIORITY = ("wikidata", "wikivoyage", "osm", "overture", "foursquare")


def source_priority_sql(column: str = "source") -> str:
    """A SQL CASE giving each source its rank in SOURCE_PRIORITY (unknown sources last)."""
    whens = " ".join(f"WHEN '{s}' THEN {i}" for i, s in enumerate(SOURCE_PRIORITY, start=1))
    return f"(CASE {column} {whens} ELSE {len(SOURCE_PRIORITY) + 1} END)"
