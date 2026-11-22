"""The source registry (sources.yaml). No source runs without an entry."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field

from .settings import REGISTRY_PATH


class SourceNotRegisteredError(RuntimeError):
    pass


class SourceDisabledError(RuntimeError):
    pass


class SourceEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    enabled: bool = True
    url: str
    access: str
    licence: str
    licence_detail: str | None = None
    licence_urls: list[str] = Field(min_length=1)
    attribution: str
    terms_checked_on: date
    terms_urls: list[str] = Field(min_length=1)
    allowed_uses: list[str] = Field(min_length=1)
    notes: str | None = None

    def licence_ids(self) -> set[str]:
        """SPDX ids named in the licence expression, e.g. {"CDLA-Permissive-2.0", "Apache-2.0"}."""
        return {part.strip() for part in self.licence.split(" AND ") if part.strip()}


class Registry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sources: dict[str, SourceEntry]

    def require(self, key: str, *, allow_disabled: bool = False) -> SourceEntry:
        entry = self.sources.get(key)
        if entry is None:
            raise SourceNotRegisteredError(
                f"Source '{key}' has no entry in sources.yaml; add its licence and terms before running it."
            )
        if not entry.enabled and not allow_disabled:
            raise SourceDisabledError(
                f"Source '{key}' is disabled in sources.yaml: {(entry.notes or '').strip()}"
            )
        return entry

    def enabled(self) -> list[str]:
        return [key for key, entry in self.sources.items() if entry.enabled]


def load_registry(path: Path | None = None) -> Registry:
    with open(path or REGISTRY_PATH, encoding="utf-8") as fh:
        return Registry.model_validate(yaml.safe_load(fh))
