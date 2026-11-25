"""The stay tables of the bundle (docs/data-platform-spec.md, Feature 5): `stay_unit` rows and open-data hotels.

    stay_unit.jsonl.gz   one row per unit (city, Trippr Area, Inside Airbnb neighbourhood, H3 cell): the
                         aggregates, the score parts and the sentence that explains them. Aggregates only: no
                         listing ids, host ids, names or links to individual listings exist in the pipeline's
                         published tables, and the schema below forbids extra fields.
    hotels.jsonl.gz      open-data hotels (Overture, Foursquare, OpenStreetMap lodging) inside a Trippr Area's
                         radius, at most `hotels.bundle_per_area` per Area, each with its source records and
                         licences
    stay_unit.parquet, hotels.parquet   the same rows for DuckDB (only when the bundle writes Parquet)

Both are optional: a bundle without them loads exactly as before. The manifest's `stay` section carries the
coverage numbers, snapshot dates and the stay check results the Data page shows. The shapes are mirrored by
zod schemas in packages/contracts/src/stay.ts.
"""

from __future__ import annotations

import gzip
import logging
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from datetime import date as date_type
from pathlib import Path
from typing import Any, Literal

import h3
from pydantic import BaseModel, ConfigDict, Field

from .checks import CheckResult
from .cities import load_cities
from .duck import connect, rows, run, sql_str
from .layout import read_json
from .registry import Registry
from .settings import CONFIG_DIR, SEED_DIR
from .stay.areas import load_areas
from .stay.config import StayConfig, load_stay_config
from .stay.layout import stay_checks_file, stay_summary_file, stay_table

log = logging.getLogger(__name__)

STAY_UNIT_FILE = "stay_unit.jsonl.gz"
HOTELS_FILE = "hotels.jsonl.gz"
STAY_UNIT_PARQUET = "stay_unit.parquet"
HOTELS_PARQUET = "hotels.parquet"
STAY_FILES = (STAY_UNIT_FILE, HOTELS_FILE)


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BundleStayUnit(_Strict):
    unit_kind: Literal["city", "area", "neighbourhood", "h3"]
    unit_id: str
    city_code: str
    name: str | None
    lat: float
    lon: float
    radius_km: float | None
    area_km2: float | None
    centre_km: float | None
    station_km: float | None
    snapshot_date: str | None
    n_listings: int
    n_priced: int
    n_rated: int
    n_reviewed10: int | None
    median_price_cad: float | None
    p25_price_cad: float | None
    p75_price_cad: float | None
    median_price_entire_cad: float | None
    median_price_private_cad: float | None
    median_price_pp_cad: float | None
    entire_home_share: float | None
    private_room_share: float | None
    other_room_share: float | None
    median_rating: float | None
    reviews_ltm: int | None
    reviews_per_listing: float | None
    unavailable_share: float | None
    median_availability_365: float | None
    est_occupancy_share: float | None
    listing_density_km2: float | None
    licensed_share: float | None
    multi_host_share: float | None
    top_hosts_share: float | None
    n_hotels: int | None
    n_places: int | None
    n_nightlife: int | None
    cheaper_than_share: float | None
    score_value: float | None
    score_reviews: float | None
    score_centrality: float | None
    score_walkability: float | None
    score_quiet: float | None
    stay_score: float | None
    score_parts: list[str]
    weight_coverage: float | None
    low_sample: bool | None
    explanation: str | None


class BundleHotelSource(_Strict):
    source: str
    source_id: str
    licence: str
    fetched_at: str


class BundleHotel(_Strict):
    id: str
    city_code: str
    area_id: str
    area_dist_km: float | None
    name: str
    name_local: str | None
    name_en: str | None
    kind: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    address: str | None
    website: str | None
    phone: str | None
    stars: int | None
    wikidata_qid: str | None
    confidence: float | None
    n_sources: int = Field(ge=1)
    sources: list[BundleHotelSource] = Field(min_length=1)


class BundleStayCity(_Strict):
    city_code: str
    name: str
    snapshot_date: str | None
    n_listings: int
    n_priced: int
    median_price_cad: float | None
    median_price_pp_cad: float | None


class BundleStayCoverage(_Strict):
    trippr_cities: int
    inside_airbnb_cities: int
    cities_with_places: int


class BundleStayCheck(_Strict):
    name: str
    status: Literal["pass", "fail", "warn", "info"]
    detail: str


class BundleStayChecks(_Strict):
    passed: bool
    results: list[BundleStayCheck]


class BundleStay(_Strict):
    """The manifest's `stay` section: what the Data page shows about stay analytics."""

    run_date: str
    units: dict[str, int]
    hotels: int
    hotels_in_areas: int
    hotels_per_area_cap: int
    cities: list[BundleStayCity]
    coverage: BundleStayCoverage
    weights: dict[str, float]
    checks: BundleStayChecks | None


@dataclass
class StayData:
    units: list[BundleStayUnit]
    hotels: list[BundleHotel]
    section: BundleStay
    #: Check results for the bundle's own check list (provenance, ids, privacy).
    results: list[CheckResult]


def have_stay_tables(out: Path, date: str) -> bool:
    return stay_table(out, date, "stay_unit").is_file() and stay_table(out, date, "hotel").is_file()


def _utc(value: datetime | None) -> str:
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _unit_row(r: dict[str, Any]) -> BundleStayUnit:
    snapshot = r.get("snapshot_date")
    clean = {k: v for k, v in r.items() if k in BundleStayUnit.model_fields}
    clean["snapshot_date"] = snapshot.isoformat() if isinstance(snapshot, date_type) else snapshot
    clean["score_parts"] = list(r.get("score_parts") or [])
    # Cell centres come from h3 and differ in the last digits between platforms: publish 6 decimals (about 0.1 m).
    for key in ("lat", "lon"):
        clean[key] = round(clean[key], 6)
    return BundleStayUnit.model_validate(clean)


def load_units(path: Path) -> list[BundleStayUnit]:
    con = connect()
    out = [
        _unit_row(r)
        for r in rows(
            con,
            f"SELECT * FROM read_parquet({sql_str(path.as_posix())}) ORDER BY unit_kind, city_code, unit_id",
        )
    ]
    con.close()
    return out


def load_hotels(out: Path, date: str, per_area: int) -> tuple[list[BundleHotel], int]:
    """Hotels inside an Area's radius, at most `per_area` per Area (more sources, a website, stars and a
    closer centre first). Returns the hotels and how many there were before the cap."""
    con = connect()
    hotel_path, source_path = stay_table(out, date, "hotel"), stay_table(out, date, "hotel_source")
    records = {
        (r["source"], r["source_id"]): r
        for r in rows(
            con,
            f"SELECT source, source_id, licence, fetched_at FROM read_parquet({sql_str(source_path.as_posix())})",
        )
    }
    total = int(
        run(
            con,
            f"SELECT count(*) FROM read_parquet({sql_str(hotel_path.as_posix())}) WHERE area_id IS NOT NULL",
        )[0][0]
    )
    hotels: list[BundleHotel] = []
    for r in rows(
        con,
        f"""SELECT * FROM (
              SELECT h.*, row_number() OVER (
                PARTITION BY area_id
                ORDER BY n_sources DESC, (website IS NOT NULL) DESC, (stars IS NOT NULL) DESC,
                         confidence DESC NULLS LAST, area_dist_km, hotel_id) AS rk
              FROM read_parquet({sql_str(hotel_path.as_posix())}) h WHERE area_id IS NOT NULL)
            WHERE rk <= {int(per_area)} ORDER BY city_code, area_id, rk""",
    ):
        sources = []
        for ref in r["sources"]:
            source, _, source_id = ref.partition(":")
            rec = records.get((source, source_id))
            if rec is not None:
                sources.append(
                    BundleHotelSource(
                        source=source,
                        source_id=source_id,
                        licence=rec["licence"] or "",
                        fetched_at=_utc(rec["fetched_at"]),
                    )
                )
        hotels.append(
            BundleHotel(
                id=r["hotel_id"],
                city_code=r["city_code"],
                area_id=r["area_id"],
                area_dist_km=r["area_dist_km"],
                name=r["name"],
                name_local=r["name_local"],
                name_en=r["name_en"],
                kind=r["kind"],
                lat=round(r["lat"], 7),
                lon=round(r["lon"], 7),
                address=r["address"],
                website=r["website"],
                phone=r["phone"],
                stars=r["stars"],
                wikidata_qid=r["wikidata_qid"],
                confidence=None if r["confidence"] is None else round(r["confidence"], 3),
                n_sources=r["n_sources"],
                sources=sources,
            )
        )
    con.close()
    return hotels, total


def write_jsonl_gz(path: Path, items: Iterable[BaseModel]) -> int:
    """Gzipped JSON Lines; mtime 0 so the same rows always give the same bytes."""
    n = 0
    with open(path, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as gz:
        for item in items:
            gz.write((item.model_dump_json() + "\n").encode("utf-8"))
            n += 1
    return n


def read_jsonl_gz(path: Path, model: type[BaseModel]) -> list[Any]:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return [model.model_validate_json(line) for line in fh if line.strip()]


def write_parquet_copies(out: Path, date: str, target: Path, hotels: list[BundleHotel]) -> list[str]:
    """stay_unit.parquet (a copy of the curated table) and hotels.parquet (the bundled hotels)."""
    import shutil

    shutil.copyfile(stay_table(out, date, "stay_unit"), target / STAY_UNIT_PARQUET)
    con = connect()
    run(
        con,
        "CREATE TABLE hotels (id VARCHAR, city_code VARCHAR, area_id VARCHAR, name VARCHAR, kind VARCHAR, "
        "lat DOUBLE, lon DOUBLE, website VARCHAR, stars INTEGER, n_sources INTEGER, sources VARCHAR[])",
    )
    con.executemany(
        "INSERT INTO hotels VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            [
                h.id,
                h.city_code,
                h.area_id,
                h.name,
                h.kind,
                h.lat,
                h.lon,
                h.website,
                h.stars,
                h.n_sources,
                [f"{s.source}:{s.source_id}" for s in h.sources],
            ]
            for h in hotels
        ],
    )
    run(
        con,
        f"COPY (SELECT * FROM hotels ORDER BY city_code, area_id, id) TO {sql_str((target / HOTELS_PARQUET).as_posix())} "
        "(FORMAT parquet, COMPRESSION zstd)",
    )
    con.close()
    return [STAY_UNIT_PARQUET, HOTELS_PARQUET]


# --- checks -------------------------------------------------------------------------------------------


def check_stay_bundle(
    units: list[BundleStayUnit],
    hotels: list[BundleHotel],
    *,
    registry: Registry,
    cfg: StayConfig,
    seed_dir: Path = SEED_DIR,
) -> list[CheckResult]:
    """Checks on the rows as they go into the bundle. A failure marks the whole bundle failed."""
    results: list[CheckResult] = []

    def add(name: str, bad: list[str], ok: str, fail: str) -> None:
        results.append(
            CheckResult(name, "fail", f"{fail}: {bad[:3]}") if bad else CheckResult(name, "pass", ok)
        )

    counts = Counter((u.unit_kind, u.unit_id) for u in units)
    add(
        "stay.units.unique_ids",
        [f"{k}:{i}" for (k, i), n in counts.items() if n > 1],
        f"{len(units):,} stay units, ids unique per kind",
        "duplicate stay unit ids",
    )
    area_ids = {u.unit_id for u in units if u.unit_kind == "area"}
    areas, missing = load_areas(cfg.areas.default_radius_km, seed_dir)
    known = {a.id for a in areas} | set(missing)
    add(
        "stay.units.areas_known",
        sorted(area_ids - known),
        f"{len(area_ids)} area units, all in seed/areas.json",
        "area units that are not in seed/areas.json",
    )
    cities = {c.code for c in load_cities(seed_dir)}
    add(
        "stay.units.cities_known",
        sorted({u.city_code for u in units} - cities),
        "every unit is in a Trippr city",
        "units in unknown cities",
    )
    bad_cells = [
        u.unit_id
        for u in units
        if u.unit_kind == "h3"
        and not (h3.is_valid_cell(u.unit_id) and h3.get_resolution(u.unit_id) == cfg.h3_resolution)
    ]
    add(
        "stay.units.h3_cells",
        bad_cells,
        f"H3 cells are valid at resolution {cfg.h3_resolution}",
        "H3 cells that are not valid at the configured resolution",
    )
    leaks = [
        f"{u.unit_kind}:{u.unit_id}"
        for u in units
        if u.n_listings < cfg.privacy.min_listings
        and any(
            getattr(u, f) is not None
            for f in ("median_price_cad", "median_rating", "multi_host_share", "top_hosts_share")
        )
    ]
    add(
        "stay.units.privacy_minimum",
        leaks,
        f"no statistics for units under {cfg.privacy.min_listings} listings",
        "units under the privacy minimum that publish statistics",
    )
    thin = [f"{u.unit_kind}:{u.unit_id}" for u in units if u.stay_score is not None and not u.explanation]
    add(
        "stay.units.explained",
        thin,
        "every scored unit has an explanation",
        "scored units without an explanation",
    )
    hotel_counts = Counter(h.id for h in hotels)
    add(
        "stay.hotels.unique_ids",
        [i for i, n in hotel_counts.items() if n > 1],
        f"{len(hotels):,} hotels, ids unique",
        "duplicate hotel ids",
    )
    add(
        "stay.hotels.areas",
        sorted({h.area_id for h in hotels} - area_ids),
        "every hotel's Area has a stay unit",
        "hotels in Areas without a stay unit",
    )
    unlicensed = [h.id for h in hotels if any(not s.licence.strip() for s in h.sources)]
    unregistered = sorted({s.source for h in hotels for s in h.sources if s.source not in registry.sources})
    add(
        "stay.hotels.provenance",
        unlicensed + unregistered,
        "every hotel source record has a licence and a registered source",
        "hotels with a missing licence or an unregistered source",
    )
    return results


def build_stay(
    out: Path,
    date: str,
    *,
    registry: Registry,
    config_dir: Path = CONFIG_DIR,
    seed_dir: Path = SEED_DIR,
) -> StayData | None:
    """Everything the bundle takes from the stay stages for `date`, or None when they have not run."""
    if not have_stay_tables(out, date):
        return None
    cfg = load_stay_config(config_dir)
    units = load_units(stay_table(out, date, "stay_unit"))
    hotels, in_areas = load_hotels(out, date, cfg.hotels.bundle_per_area)
    results = check_stay_bundle(units, hotels, registry=registry, cfg=cfg, seed_dir=seed_dir)

    checks_path = stay_checks_file(out, date)
    checks: BundleStayChecks | None = None
    if checks_path.is_file():
        raw = read_json(checks_path)
        checks = BundleStayChecks(
            passed=bool(raw["passed"]),
            results=[
                BundleStayCheck(name=r["name"], status=r["status"], detail=r["detail"])
                for r in raw["results"]
            ],
        )
    else:
        results.append(
            CheckResult("stay.checks", "warn", f"no stay check results at {checks_path.name}; run stay-check")
        )
    if checks is not None and not checks.passed:
        failed = [r.name for r in checks.results if r.status == "fail"]
        results.append(CheckResult("stay.checks", "fail", f"the stay checks failed: {failed[:5]}"))

    summary_path = stay_summary_file(out, date)
    summary = read_json(summary_path) if summary_path.is_file() else {}
    city_units = [u for u in units if u.unit_kind == "city"]
    all_cities = load_cities(seed_dir, config_dir)
    coverage = summary.get("coverage") or {}
    section = BundleStay(
        run_date=date,
        units={k: sum(1 for u in units if u.unit_kind == k) for k in ("city", "area", "neighbourhood", "h3")},
        hotels=len(hotels),
        hotels_in_areas=in_areas,
        hotels_per_area_cap=cfg.hotels.bundle_per_area,
        cities=[
            BundleStayCity(
                city_code=u.city_code,
                name=u.name or u.city_code,
                snapshot_date=u.snapshot_date,
                n_listings=u.n_listings,
                n_priced=u.n_priced,
                median_price_cad=u.median_price_cad,
                median_price_pp_cad=u.median_price_pp_cad,
            )
            for u in city_units
        ],
        coverage=BundleStayCoverage(
            trippr_cities=int(coverage.get("trippr_cities", len(all_cities))),
            inside_airbnb_cities=len(city_units),
            cities_with_places=int(coverage.get("cities_with_staged_places", 0)),
        ),
        weights={k: float(v) for k, v in cfg.weights.model_dump().items()},
        checks=checks,
    )
    return StayData(units=units, hotels=hotels, section=section, results=results)
