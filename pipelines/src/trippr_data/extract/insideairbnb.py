"""Inside Airbnb: public city snapshots (CC BY 4.0), downloaded politely, once per snapshot.

Docs checked 2026-11-23:
- https://insideairbnb.com/get-the-data/ (the index; one data folder per city and snapshot date)
- https://insideairbnb.com/data-policies/ (take only what you need, no scraping, download once, no republishing)

Inside Airbnb covers some cities only. The five that fall in Trippr's 19 countries are listed in
config/insideairbnb_cities.csv. For each, the newest snapshot on the index is fetched:

    data/listings.csv.gz            detailed listings (price, room type, reviews, availability, host counts)
    data/calendar.csv.gz            per-listing daily availability for the next year
    visualisations/reviews.csv      review dates per listing (the "reviews summary")
    visualisations/neighbourhoods.* neighbourhood names and polygons

Files already in raw/ for the same snapshot are not downloaded again (checksums in _meta.json are kept).
"""

from __future__ import annotations

import csv
import logging
import re
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..cities import City
from ..duck import connect, scalar, sql_str
from ..layout import raw_dir, read_json, write_json
from ..registry import Registry
from ..settings import CONFIG_DIR, utc_now
from .common import sha256_file
from .polite_http import PoliteClient

log = logging.getLogger(__name__)

SOURCE = "insideairbnb"
INDEX_URL = "https://insideairbnb.com/get-the-data/"
DATA_HOST = "https://data.insideairbnb.com"

# What we download for each snapshot: local name -> path under <country>/<region>/<city>/<date>/.
SNAPSHOT_FILES: dict[str, str] = {
    "listings.csv.gz": "data/listings.csv.gz",
    "calendar.csv.gz": "data/calendar.csv.gz",
    "reviews.csv": "visualisations/reviews.csv",
    "neighbourhoods.csv": "visualisations/neighbourhoods.csv",
    "neighbourhoods.geojson": "visualisations/neighbourhoods.geojson",
}
# Files that are CSV and worth a row count in the manifest.
COUNTED = ("listings.csv.gz", "calendar.csv.gz", "reviews.csv")

# Trippr's countries (ISO) -> the country segments Inside Airbnb uses (Hong Kong is listed under china).
COUNTRY_SLUGS: dict[str, tuple[str, ...]] = {
    "JP": ("japan",),
    "KR": ("south-korea",),
    "CN": ("china",),
    "HK": ("china", "hong-kong"),
    "MO": ("china", "macau"),
    "TW": ("taiwan",),
    "VN": ("vietnam",),
    "TH": ("thailand",),
    "KH": ("cambodia",),
    "LA": ("laos",),
    "MY": ("malaysia",),
    "SG": ("singapore",),
    "PH": ("philippines",),
    "ID": ("indonesia",),
    "BN": ("brunei",),
    "MN": ("mongolia",),
    "LK": ("sri-lanka",),
    "NP": ("nepal",),
    "MV": ("maldives",),
}

SEGMENT = r"[^/\"'<> ]+"


def listings_link(data_host: str = DATA_HOST) -> re.Pattern[str]:
    return re.compile(
        re.escape(data_host)
        + rf"/(?P<country>{SEGMENT})/(?P<region>{SEGMENT})/(?P<city>{SEGMENT})/"
        + r"(?P<date>\d{4}-\d{2}-\d{2})/data/listings\.csv\.gz"
    )


@dataclass(frozen=True)
class AirbnbCity:
    code: str
    country: str
    region: str
    city: str
    currency: str

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.country, self.region, self.city)

    def file_url(self, snapshot: str, name: str, host: str = DATA_HOST) -> str:
        path = "/".join((self.country, self.region, self.city, snapshot, SNAPSHOT_FILES[name]))
        return f"{host}/{path}"


def load_city_map(config_dir: Path = CONFIG_DIR) -> dict[str, AirbnbCity]:
    path = config_dir / "insideairbnb_cities.csv"
    with open(path, encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(line for line in fh if line.strip() and not line.startswith("#")))
    return {
        r["code"]: AirbnbCity(r["code"], r["country"], r["region"], r["city"], r["currency"]) for r in rows
    }


def parse_index(html: str, data_host: str = DATA_HOST) -> dict[tuple[str, str, str], list[str]]:
    """Snapshot dates (oldest first) for each (country, region, city) that has a listings file on the page."""
    found: dict[tuple[str, str, str], set[str]] = {}
    for m in listings_link(data_host).finditer(html):
        key = tuple(urllib.parse.unquote(m.group(g)) for g in ("country", "region", "city"))
        found.setdefault(key, set()).add(m.group("date"))  # type: ignore[arg-type]
    return {k: sorted(v) for k, v in found.items()}


def unmapped_datasets(
    index: dict[tuple[str, str, str], list[str]], mapped: dict[str, AirbnbCity], cities: list[City]
) -> list[tuple[str, str, str]]:
    """Index entries in a Trippr country that config/insideairbnb_cities.csv doesn't know yet."""
    slugs = {slug for c in cities for slug in COUNTRY_SLUGS.get(c.country, ())}
    known = {m.key for m in mapped.values()}
    return sorted(k for k in index if k[0] in slugs and k not in known)


def fx_needs(meta: dict[str, Any], mapping: dict[str, AirbnbCity]) -> tuple[list[str], str, str]:
    """(currencies, first snapshot date, last snapshot date) the downloaded snapshots need rates for."""
    snapshots = meta.get("snapshots", {})
    currencies = sorted({mapping[code].currency for code in snapshots if code in mapping})
    if not snapshots:
        return [], "", ""
    return currencies, min(snapshots.values()), max(snapshots.values())


def _row_count(path: Path) -> int:
    con = connect()
    try:
        return int(
            scalar(con, f"SELECT count(*) FROM read_csv({sql_str(path.as_posix())}, all_varchar = true)")
        )
    finally:
        con.close()


def extract(
    cities: list[City],
    *,
    out: Path,
    date: str,
    registry: Registry,
    client: PoliteClient | None = None,
    force: bool = False,
    config_dir: Path = CONFIG_DIR,
    index_url: str = INDEX_URL,
    data_host: str = DATA_HOST,
) -> dict[str, Any]:
    entry = registry.require(SOURCE)
    client = client or PoliteClient()
    mapping = load_city_map(config_dir)
    wanted = [c for c in cities if c.code in mapping]
    not_covered = [c.code for c in cities if c.code not in mapping]
    directory = raw_dir(out, SOURCE, date)
    directory.mkdir(parents=True, exist_ok=True)
    meta_path = directory / "_meta.json"
    previous = read_json(meta_path) if meta_path.is_file() else {}
    files: dict[str, dict[str, Any]] = dict(previous.get("files", {}))

    log.info("insideairbnb: %d of %d cities are covered", len(wanted), len(cities))
    index = parse_index(client.get_text(index_url), data_host)
    for key in unmapped_datasets(index, mapping, cities):
        log.warning("Inside Airbnb now lists %s; add it to config/insideairbnb_cities.csv", "/".join(key))

    snapshots: dict[str, str] = dict(previous.get("snapshots", {}))
    for city in wanted:
        ab = mapping[city.code]
        dates = index.get(ab.key)
        if not dates:
            log.warning("%s: no %s dataset on the Inside Airbnb index any more", city.code, "/".join(ab.key))
            continue
        snapshot = dates[-1]
        snapshots[city.code] = snapshot
        for name in SNAPSHOT_FILES:
            rel = f"{city.code}/{name}"
            target = directory / city.code / name
            known = files.get(rel)
            if not force and target.is_file() and known and known.get("snapshot") == snapshot:
                if sha256_file(target) == known["sha256"]:
                    log.info("%s already downloaded for %s; not fetching again", rel, snapshot)
                    continue
            url = ab.file_url(snapshot, name, data_host)
            log.info("downloading %s", url)
            size, sha = client.download(url, target)
            files[rel] = {
                "city": city.code,
                "name": name,
                "snapshot": snapshot,
                "url": url,
                "bytes": size,
                "sha256": sha,
                "rows": _row_count(target) if name in COUNTED else None,
                "fetched_at": utc_now().isoformat(),
            }

    covered = sorted({f["city"] for f in files.values()})
    meta = {
        "source": SOURCE,
        "source_name": entry.name,
        "licence": entry.licence,
        "attribution": entry.attribution.strip(),
        "terms_checked_on": entry.terms_checked_on.isoformat(),
        "version": max(snapshots.values()) if snapshots else None,
        "dataset_path": index_url,
        "query_template": f"{DATA_HOST}/<country>/<region>/<city>/<snapshot>/<file>",
        "run_date": date,
        "fetched_at": max((f["fetched_at"] for f in files.values()), default=utc_now().isoformat()),
        "row_count": sum(f["rows"] or 0 for f in files.values() if f["name"] == "listings.csv.gz"),
        "user_agent": client.user_agent,
        "requests": client.requests,
        "snapshots": dict(sorted(snapshots.items())),
        "coverage": {
            "covered": covered,
            "not_covered_in_this_run": sorted(not_covered),
            "note": "Inside Airbnb has datasets only for some cities; see config/insideairbnb_cities.csv",
        },
        "files": dict(sorted(files.items())),
    }
    write_json(meta_path, meta)
    return meta

