"""OpenStreetMap via the Overpass API: one bounded query per city, cached on disk.

Why Overpass and not a Geofabrik extract: the trip is 108 cities, each a circle of 10 to 25 km, so the
interesting data is a few hundred MB of tagged features, while the country extracts that cover them
(Japan, China, Indonesia, ...) are over 10 GB to download and need a PBF reader and a node-location
index (several GB of disk or RAM) to cut out. One query per city, run once a month with long pauses
and cached for the run, stays well below Overpass's published limits (10,000 queries and 1 GB a day).
If this ever has to run weekly, switch to Geofabrik extracts.

The query is generated from config/category_map_osm.csv (the first tag of every rule that is not
"exclude"), so that file decides what is fetched and how it is mapped. Only features with a `name` are
fetched: an unnamed point cannot be matched or shown.

Usage policy checked 2026-11-22:
- https://dev.overpass-api.de/overpass-doc/en/preface/commons.html (about 10,000 queries and 1 GB a day)
- https://wiki.openstreetmap.org/wiki/Overpass_API (identify the app, cache, rate-limit, no parallel
  scripts, wait 30 s after a 429)
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import re
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..cities import City
from ..duck import connect, sql_str
from ..layout import raw_dir
from ..registry import Registry
from ..settings import CONFIG_DIR
from ..taxonomy import load_category_map, load_taxonomy, osm_fetch_tags
from .common import ExtractRun
from .http import USER_AGENT, HttpError, PoliteClient

log = logging.getLogger(__name__)

SOURCE = "osm"
ENDPOINT = "https://overpass-api.de/api/interpreter"
# Tried in order. The main instance is the reference one; the second is a community instance
# (https://overpass.private.coffee/, no rate limit, "identify your project" in the User-Agent) used only
# when the main one is at capacity, which it often is.
ENDPOINTS = (
    ("https://overpass-api.de/api/interpreter", "https://overpass-api.de/api/status"),
    ("https://overpass.private.coffee/api/interpreter", "https://overpass.private.coffee/api/status"),
)
QUERY_TIMEOUT_S = 150
MIN_INTERVAL_S = 10.0


class OverpassIncompleteError(RuntimeError):
    """Some cities could not be fetched (the servers were busy); the others are cached and written.
    Run the same command again: cached cities are not queried twice."""

    def __init__(self, cities: list[str], message: str) -> None:
        super().__init__(message)
        self.cities = cities


def build_query(city: City, fetch: dict[str, list[str]]) -> str:
    """One union of exact tag filters inside the city's bounding box; `out center` gives ways and
    relations a point. Exact `key=value` filters use Overpass's tag index (regular expressions scan);
    staging crops the box to the city's circle."""
    min_lon, min_lat, max_lon, max_lat = city.bbox
    box = f"({min_lat},{min_lon},{max_lat},{max_lon})"
    parts = [f'  nwr["{key}"="{value}"]["name"]{box};' for key, values in fetch.items() for value in values]
    body = "\n".join(parts)
    header = f"[out:json][timeout:{QUERY_TIMEOUT_S}][maxsize:2147483648];"
    return "\n".join([header, "(", body, ");", "out center tags;"])


def elements_to_ndjson(response: dict[str, Any]) -> list[str]:
    """One JSON line per element with a point: nodes use lat/lon, ways and relations use `center`."""
    lines = []
    for el in response.get("elements", []):
        point = el if "lat" in el else el.get("center")
        if not point or "lat" not in point:
            continue
        lines.append(
            json.dumps(
                {
                    "osm_type": el["type"],
                    "osm_id": el["id"],
                    "lat": point["lat"],
                    "lon": point["lon"],
                    "tags": el.get("tags", {}),
                },
                ensure_ascii=False,
            )
        )
    return lines


def wait_for_slot(client: PoliteClient, status_url: str, sleep: Callable[[float], None] = time.sleep) -> None:
    """Ask /api/status for a free slot and wait for it, so the query is not queued or rejected."""
    for _ in range(10):
        try:
            text = client.request(status_url, retries=1).decode("utf-8", "replace")
        except HttpError as err:  # the status page is a courtesy check; a busy server may not answer it
            log.warning("overpass status unavailable (%s); trying the query anyway", err)
            return
        if re.search(r"[1-9]\d* slots? available now", text) or "Rate limit: 0" in text:
            return
        match = re.search(r"in (\d+) seconds", text)
        wait = min(int(match.group(1)) + 1, 120) if match else 15
        log.info("overpass: no free slot, waiting %ds", wait)
        sleep(wait)


# Tags whose features dominate the volume (restaurants and cafes are most of what OSM holds in a big
# city). They go in their own query so a busy server failing it does not lose the sights.
FOOD_TAGS = frozenset(
    {
        "amenity=restaurant",
        "amenity=fast_food",
        "amenity=cafe",
        "amenity=bar",
        "amenity=pub",
        "amenity=biergarten",
        "amenity=ice_cream",
        "amenity=food_court",
        "shop=bakery",
        "shop=pastry",
        "shop=confectionery",
        "shop=coffee",
        "shop=tea",
    }
)


def query_groups(fetch: dict[str, list[str]]) -> dict[str, dict[str, list[str]]]:
    """Split the tag filters into lighter queries: sights (tourism, historic, natural, leisure ...),
    other amenities (worship, theatres, markets ...), food and drink, and other shops. A busy public
    server completes small queries far more often than one query for everything."""
    groups: dict[str, dict[str, list[str]]] = {"sights": {}, "amenity": {}, "shop": {}, "food": {}}
    for key, values in fetch.items():
        for value in values:
            if f"{key}={value}" in FOOD_TAGS:
                name = "food"
            else:
                name = key if key in ("amenity", "shop") else "sights"
            groups[name].setdefault(key, []).append(value)
    wanted = {g.strip() for g in os.environ.get("OSM_GROUPS", "").split(",") if g.strip()}
    return {name: tags for name, tags in groups.items() if tags and (not wanted or name in wanted)}


def fetch_group(
    city: City,
    group: str,
    tags: dict[str, list[str]],
    directory: Path,
    client: PoliteClient,
    endpoints: tuple[tuple[str, str], ...],
) -> tuple[Path, bool, str | None]:
    """One group's cached response for a city (downloading it when missing).

    Returns (path, from_cache, endpoint used). Each endpoint gets two attempts before the next is tried.
    """
    cache = directory / f"{city.code}.{group}.overpass.json.gz"
    if cache.is_file():
        return cache, True, None
    query = build_query(city, tags)
    last: Exception | None = None
    for endpoint, status_url in endpoints:
        try:
            wait_for_slot(client, status_url)
            payload = client.request(
                endpoint,
                data={"data": query},
                headers={"Accept": "application/json"},
                retries=2 if endpoint == endpoints[0][0] else 1,
            )
            json.loads(payload)  # a busy server can answer 200 with an HTML or remark page
        except (HttpError, ValueError) as err:
            log.warning("%s/%s: %s failed (%s); trying the next endpoint", city.code, group, endpoint, err)
            last = err
            continue
        directory.mkdir(parents=True, exist_ok=True)
        tmp = cache.with_suffix(".tmp")
        tmp.write_bytes(gzip.compress(payload, compresslevel=6))
        tmp.replace(cache)
        return cache, False, endpoint
    raise HttpError(f"{city.code}/{group}: every Overpass endpoint failed; last error: {last}")


def fetch_city(
    city: City,
    directory: Path,
    client: PoliteClient,
    fetch: dict[str, list[str]],
    endpoints: tuple[tuple[str, str], ...] = ENDPOINTS,
) -> tuple[list[Path], bool, list[str], list[str]]:
    """All cached responses for a city: (paths, all from cache, endpoints used, groups still missing).

    A single-file response from an earlier run (<CITY>.overpass.json.gz, everything in one query) is
    accepted as is. Finished groups stay cached when a later group fails, so a re-run only repeats the
    missing ones.
    """
    legacy = directory / f"{city.code}.overpass.json.gz"
    if legacy.is_file():
        return [legacy], True, [], []
    paths, cached, used, missing = [], True, [], []
    for group, tags in query_groups(fetch).items():
        try:
            path, from_cache, endpoint = fetch_group(city, group, tags, directory, client, endpoints)
        except HttpError as err:
            log.error("osm %s: group %s not fetched: %s", city.code, group, err)
            missing.append(group)
            continue
        paths.append(path)
        cached = cached and from_cache
        if endpoint:
            used.append(endpoint)
    return paths, cached, used, missing


def merge_responses(paths: list[Path]) -> dict[str, Any]:
    """One response from several: elements de-duplicated by (type, id), the oldest data timestamp kept."""
    elements: dict[tuple[str, int], Any] = {}
    stamps = []
    for path in paths:
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            response = json.load(fh)
        stamps.append((response.get("osm3s") or {}).get("timestamp_osm_base"))
        for el in response.get("elements", []):
            elements[(el["type"], el["id"])] = el
    stamp = min((s for s in stamps if s), default=None)
    return {"osm3s": {"timestamp_osm_base": stamp}, "elements": list(elements.values())}


def extract(
    cities: list[City],
    *,
    out: Path,
    date: str,
    registry: Registry,
    client: PoliteClient | None = None,
    config_dir: Path = CONFIG_DIR,
) -> dict[str, Any]:
    entry = registry.require(SOURCE)
    rules = load_category_map(SOURCE, load_taxonomy(config_dir), config_dir).rules
    fetch = osm_fetch_tags(rules)
    client = client or PoliteClient(
        min_interval=MIN_INTERVAL_S, timeout=QUERY_TIMEOUT_S + 30, retries=5, backoff=30.0
    )
    template_city = City("<code>", "", "", 0.0, 0.0, "city", 0.0)
    job = ExtractRun(
        source=SOURCE,
        entry=entry,
        out=out,
        date=date,
        version=f"overpass-{date}",
        dataset_path=ENDPOINT,
        query_template=build_query(template_city, fetch).replace(
            "(0.0,0.0,0.0,0.0)", "(<min_lat>,<min_lon>,<max_lat>,<max_lon>)"
        ),
        extra={
            "endpoint": ENDPOINT,
            "user_agent": USER_AGENT,
            "min_interval_seconds": client.min_interval,
            "usage_policy": "https://dev.overpass-api.de/overpass-doc/en/preface/commons.html",
            "fetched_tags": fetch,
        },
    )
    directory = raw_dir(out, SOURCE, date)
    con = connect()
    files: dict[str, dict[str, Any]] = {}
    failed: list[str] = []
    incomplete: list[str] = []
    for city in cities:
        started = time.monotonic()
        caches, cached, endpoints_used, missing = fetch_city(city, directory, client, fetch)
        if not caches:
            failed.append(city.code)
            continue
        if missing:
            incomplete.append(city.code)
        response = merge_responses(caches)
        lines = elements_to_ndjson(response)
        nd = directory / f"{city.code}.ndjson.tmp"
        nd.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
        select = (
            f"SELECT * FROM read_json({sql_str(nd.as_posix())}, format = 'newline_delimited', "
            "columns = {osm_type: 'VARCHAR', osm_id: 'BIGINT', lat: 'DOUBLE', lon: 'DOUBLE', "
            "tags: 'MAP(VARCHAR, VARCHAR)'}) ORDER BY osm_type, osm_id"
        )
        info = job.write_city(con, city, select)
        nd.unlink(missing_ok=True)
        info["cache_files"] = [c.name for c in caches]
        info["from_cache"] = cached
        info["endpoints"] = sorted(set(endpoints_used))
        info["missing_groups"] = missing
        info["osm_base"] = (response.get("osm3s") or {}).get("timestamp_osm_base")
        info["seconds"] = round(time.monotonic() - started, 1)
        files[f"{city.code}.parquet"] = info
    con.close()
    meta = job.write_meta(files) if files else {}
    if failed or incomplete:
        raise OverpassIncompleteError(
            failed + incomplete,
            f"Overpass could not serve every query: no data for {failed or 'none'}, "
            f"some groups missing for {incomplete or 'none'}; the rest is cached, run the command again",
        )
    return meta
