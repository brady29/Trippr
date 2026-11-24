"""Small geometry helpers: polygon areas for neighbourhood density, H3 cells for the map layer."""

from __future__ import annotations

import json
import math
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

import h3

from ..cities import KM_PER_DEGREE_LAT

Ring = Sequence[Sequence[float]]  # [[lon, lat], ...]


def ring_area_km2(ring: Ring, lat0: float) -> float:
    """Area of one ring by the shoelace formula on an equirectangular projection around lat0.

    Good to well under 1% for city-sized shapes; the sign is dropped."""
    kx = KM_PER_DEGREE_LAT * math.cos(math.radians(lat0))
    ky = KM_PER_DEGREE_LAT
    pts = [(p[0] * kx, p[1] * ky) for p in ring]
    total = 0.0
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1], strict=True):
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def polygon_area_km2(rings: Sequence[Ring]) -> float:
    """A polygon given as [exterior, hole, hole, ...]."""
    if not rings:
        return 0.0
    lat0 = sum(p[1] for p in rings[0]) / len(rings[0])
    return max(0.0, ring_area_km2(rings[0], lat0) - sum(ring_area_km2(r, lat0) for r in rings[1:]))


def geometry_area_km2(geometry: dict[str, Any]) -> float:
    kind = geometry.get("type")
    coords = geometry.get("coordinates") or []
    if kind == "Polygon":
        return polygon_area_km2(coords)
    if kind == "MultiPolygon":
        return sum(polygon_area_km2(poly) for poly in coords)
    return 0.0


def neighbourhood_areas(geojson_path: Path) -> dict[str, float]:
    """{neighbourhood name: area in km2} from an Inside Airbnb neighbourhoods.geojson."""
    with open(geojson_path, encoding="utf-8") as fh:
        data = json.load(fh)
    areas: dict[str, float] = {}
    for feature in data.get("features", []):
        name = (feature.get("properties") or {}).get("neighbourhood")
        if name is None:
            continue
        areas[name] = areas.get(name, 0.0) + geometry_area_km2(feature.get("geometry") or {})
    return areas


def h3_cell(lat: float, lon: float, resolution: int) -> str:
    return h3.latlng_to_cell(lat, lon, resolution)


def h3_centre(cell: str) -> tuple[float, float]:
    lat, lon = h3.cell_to_latlng(cell)
    return lat, lon


def h3_area_km2(cell: str) -> float:
    return h3.cell_area(cell, unit="km^2")


def h3_boundary(cell: str) -> list[tuple[float, float]]:
    """(lat, lon) corners of the cell, for the map layer."""
    return list(h3.cell_to_boundary(cell))


def circle_area_km2(radius_km: float) -> float:
    return math.pi * radius_km**2


def h3_cells(points: Iterable[tuple[float, float]], resolution: int) -> set[str]:
    return {h3_cell(lat, lon, resolution) for lat, lon in points}
