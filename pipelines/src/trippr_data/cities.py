"""Trippr cities from the seed, each with a radius and a bounding box."""

from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass
from pathlib import Path

from .settings import CONFIG_DIR, SEED_DIR, SMALL_PLACE_RADIUS_KM, city_radius_default_km

EARTH_RADIUS_KM = 6371.0088
KM_PER_DEGREE_LAT = 111.32


@dataclass(frozen=True)
class City:
    code: str
    name: str
    country: str
    lat: float
    lon: float
    kind: str
    radius_km: float

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        """(min_lon, min_lat, max_lon, max_lat) enclosing the city's radius."""
        return bbox_around(self.lat, self.lon, self.radius_km)


@dataclass(frozen=True)
class Country:
    iso: str
    min_lon: float
    min_lat: float
    max_lon: float
    max_lat: float
    languages: tuple[str, ...]


def bbox_around(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    dlat = radius_km / KM_PER_DEGREE_LAT
    dlon = radius_km / (KM_PER_DEGREE_LAT * max(math.cos(math.radians(lat)), 0.01))
    return (round(lon - dlon, 6), round(lat - dlat, 6), round(lon + dlon, 6), round(lat + dlat, 6))


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def _read_csv(path: Path) -> list[dict[str, str]]:
    with open(path, encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(line for line in fh if not line.startswith("#")))


def load_radius_overrides(config_dir: Path = CONFIG_DIR) -> dict[str, float]:
    return {row["code"]: float(row["radius_km"]) for row in _read_csv(config_dir / "city_radius.csv")}


def default_radius_for_kind(kind: str) -> float:
    """Big cities get the default radius; smaller kinds (town, island, ...) get 10 km."""
    return city_radius_default_km() if kind == "city" else SMALL_PLACE_RADIUS_KM


def load_cities(seed_dir: Path = SEED_DIR, config_dir: Path = CONFIG_DIR) -> list[City]:
    with open(seed_dir / "cities.json", encoding="utf-8") as fh:
        raw = json.load(fh)
    overrides = load_radius_overrides(config_dir)
    unknown = set(overrides) - {c["code"] for c in raw}
    if unknown:
        raise ValueError(f"city_radius.csv names unknown cities: {sorted(unknown)}")
    cities = []
    for c in raw:
        kind = c.get("kind") or "city"
        radius = overrides.get(c["code"], default_radius_for_kind(kind))
        cities.append(
            City(
                code=c["code"],
                name=c["name"],
                country=c["country"],
                lat=float(c["lat"]),
                lon=float(c["lon"]),
                kind=kind,
                radius_km=radius,
            )
        )
    return cities


def load_countries(config_dir: Path = CONFIG_DIR) -> dict[str, Country]:
    return {
        row["iso"]: Country(
            iso=row["iso"],
            min_lon=float(row["min_lon"]),
            min_lat=float(row["min_lat"]),
            max_lon=float(row["max_lon"]),
            max_lat=float(row["max_lat"]),
            languages=tuple(row["languages"].split()),
        )
        for row in _read_csv(config_dir / "countries.csv")
    }


def select_cities(cities: list[City], spec: str) -> list[City]:
    """'all' or a comma-separated list of city codes, e.g. 'TYO,OSA'."""
    if spec.strip().lower() == "all":
        return list(cities)
    by_code = {c.code: c for c in cities}
    codes = [code.strip().upper() for code in spec.split(",") if code.strip()]
    missing = [code for code in codes if code not in by_code]
    if missing:
        raise ValueError(f"Unknown city codes: {', '.join(missing)}")
    if not codes:
        raise ValueError("No cities selected")
    return [by_code[code] for code in dict.fromkeys(codes)]
