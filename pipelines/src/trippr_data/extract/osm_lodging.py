"""OpenStreetMap lodging (tourism=hotel|hostel|guest_house|apartment|motel) from the Overpass API.

A stand-in until PR 2's full OpenStreetMap extractor exists; it has its own registry entry (osm_lodging)
and does not depend on it. One query per city bounding box, one at a time, with a long pause between
queries (https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances). The response
is stored as received (JSON, centre point for ways and relations).
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from ..cities import City
from ..layout import raw_dir, read_json, write_json
from ..registry import Registry
from ..settings import utc_now
from .common import sha256_file
from .polite_http import PoliteClient

log = logging.getLogger(__name__)

SOURCE = "osm_lodging"
ENDPOINT = "https://overpass-api.de/api/interpreter"
TOURISM_VALUES = ("hotel", "hostel", "guest_house", "apartment", "motel")
QUERY = (
    '[out:json][timeout:180];nwr["tourism"~"^({values})$"]({south},{west},{north},{east});out center tags;'
)


def city_query(city: City) -> str:
    min_lon, min_lat, max_lon, max_lat = city.bbox
    return QUERY.format(
        values="|".join(TOURISM_VALUES), south=min_lat, west=min_lon, north=max_lat, east=max_lon
    )


def extract(
    cities: list[City],
    *,
    out: Path,
    date: str,
    registry: Registry,
    client: PoliteClient | None = None,
    pause_s: float = 10.0,
    endpoint: str = ENDPOINT,
) -> dict[str, Any]:
    entry = registry.require(SOURCE)
    client = client or PoliteClient(min_interval_s=pause_s, timeout_s=240.0, backoff_s=30.0)
    directory = raw_dir(out, SOURCE, date)
    directory.mkdir(parents=True, exist_ok=True)
    meta_path = directory / "_meta.json"
    files: dict[str, dict[str, Any]] = read_json(meta_path)["files"] if meta_path.is_file() else {}
    for city in cities:
        started = time.monotonic()
        body = client.post_form(endpoint, {"data": city_query(city)})
        data = json.loads(body)  # fail loudly on an error page
        if "elements" not in data:
            raise RuntimeError(f"{city.code}: Overpass answered without elements: {str(data)[:200]}")
        target = directory / f"{city.code}.json"
        tmp = target.with_suffix(".json.tmp")
        tmp.write_bytes(body)
        tmp.replace(target)
        files[target.name] = {
            "city": city.code,
            "country": city.country,
            "radius_km": city.radius_km,
            "bbox": list(city.bbox),
            "rows": len(data["elements"]),
            "bytes": target.stat().st_size,
            "sha256": sha256_file(target),
            "osm_base": (data.get("osm3s") or {}).get("timestamp_osm_base"),
            "fetched_at": utc_now().isoformat(),
            "seconds": round(time.monotonic() - started, 1),
        }
        log.info("osm_lodging %s: %s elements", city.code, f"{len(data['elements']):,}")
    meta = {
        "source": SOURCE,
        "source_name": entry.name,
        "licence": entry.licence,
        "attribution": entry.attribution.strip(),
        "terms_checked_on": entry.terms_checked_on.isoformat(),
        "version": max((f["osm_base"] or "" for f in files.values()), default="") or date,
        "dataset_path": endpoint,
        "query_template": QUERY,
        "run_date": date,
        "fetched_at": max(f["fetched_at"] for f in files.values()),
        "row_count": sum(f["rows"] for f in files.values()),
        "files": dict(sorted(files.items())),
    }
    write_json(meta_path, meta)
    return meta
