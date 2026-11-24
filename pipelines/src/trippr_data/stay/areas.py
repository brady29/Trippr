"""Trippr's Areas (seed/areas.json): where to stay, per city, each a circle around its centre point."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..settings import SEED_DIR


@dataclass(frozen=True)
class Area:
    id: str
    city_code: str
    name: str
    lat: float
    lon: float
    radius_km: float


def load_areas(default_radius_km: float, seed_dir: Path = SEED_DIR) -> tuple[list[Area], list[str]]:
    """(areas with a centre, ids of areas without coordinates). An area's own `radiusKm` wins."""
    with open(seed_dir / "areas.json", encoding="utf-8") as fh:
        raw = json.load(fh)["areas"]
    areas: list[Area] = []
    missing: list[str] = []
    for a in raw:
        if a.get("lat") is None or a.get("lon") is None:
            missing.append(a["id"])
            continue
        areas.append(
            Area(
                id=a["id"],
                city_code=a["city"],
                name=a["name"],
                lat=float(a["lat"]),
                lon=float(a["lon"]),
                radius_km=float(a.get("radiusKm") or default_radius_km),
            )
        )
    return areas, missing
