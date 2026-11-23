"""The staged_place schema (docs/data-platform-spec.md, "Staged schema")."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class Signals(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confidence: float | None = Field(default=None, ge=0, le=1)
    providers: list[str] | None = None
    brand_wikidata: str | None = None
    wikidata_sitelinks: int | None = None
    wikivoyage_listed: bool | None = None
    description: str | None = None
    description_licence: str | None = None
    wikipedia_url: str | None = None


class StagedPlace(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str
    source_id: str
    name: str
    name_local: str | None
    name_en: str | None
    category_source: str
    category: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    city_code: str
    address: str | None
    website: str | None
    phone: str | None
    opening_hours: str | None
    wikidata_qid: str | None
    signals: Signals
    licence: str
    fetched_at: datetime
    raw_ref: str


SIGNALS_TYPE = (
    "STRUCT(confidence DOUBLE, providers VARCHAR[], brand_wikidata VARCHAR, "
    "wikidata_sitelinks INTEGER, wikivoyage_listed BOOLEAN, description VARCHAR, "
    "description_licence VARCHAR, wikipedia_url VARCHAR)"
)

# Column order and DuckDB types of the staged Parquet files.
STAGED_COLUMNS: dict[str, str] = {
    "source": "VARCHAR",
    "source_id": "VARCHAR",
    "name": "VARCHAR",
    "name_local": "VARCHAR",
    "name_en": "VARCHAR",
    "category_source": "VARCHAR",
    "category": "VARCHAR",
    "lat": "DOUBLE",
    "lon": "DOUBLE",
    "city_code": "VARCHAR",
    "address": "VARCHAR",
    "website": "VARCHAR",
    "phone": "VARCHAR",
    "opening_hours": "VARCHAR",
    "wikidata_qid": "VARCHAR",
    "signals": SIGNALS_TYPE,
    "licence": "VARCHAR",
    "fetched_at": "TIMESTAMP WITH TIME ZONE",
    "raw_ref": "VARCHAR",
}

assert list(STAGED_COLUMNS) == list(StagedPlace.model_fields), "schema drift"
