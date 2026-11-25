"""Stage 7, bundle: `bundles/<date>/` for the load job (docs/data-platform-spec.md, Architecture).

    places.jsonl.gz   one curated place per line (BundlePlace), ordered by city and rank: what the load job reads
    places.parquet    the same places as the curated layer wrote them, for DuckDB and BigQuery
    sources.json      the source registry entries behind the places (licence, attribution, counts, freshness)
    stay_unit.jsonl.gz, hotels.jsonl.gz (+ Parquet copies)
                      optional: stay analytics units and open-data hotels (bundle_stay.py), written when the
                      stay stages have run for the same date; a bundle without them loads as before
    manifest.json     counts, file checksums and the check results; the load job only takes a bundle whose
                      checks passed

The JSON shapes are mirrored by zod schemas in packages/contracts/src/bundle.ts; the golden test writes a
bundle from the fixtures and the API tests load that very bundle.
"""

from __future__ import annotations

import gzip
import hashlib
import logging
import os
import shutil
from collections import Counter
from collections.abc import Iterable
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from .bundle_checks import BundleCheckContext, CheckResult, run_bundle_checks
from .bundle_enrichment import (
    ENRICHMENT_FILE,
    ENRICHMENT_PARQUET_FILE,
    BundleEnrichmentSummary,
    eval_scores,
    load_enrichment,
    models_by_use,
    summarise,
    write_enrichment_jsonl,
    write_enrichment_parquet,
)
from .bundle_stay import (
    HOTELS_FILE,
    STAY_UNIT_FILE,
    BundleStay,
    build_stay,
    write_jsonl_gz,
    write_parquet_copies,
)
from .cities import load_cities, load_countries
from .curation import CurationConfig, load_curation_config
from .duck import connect, rows, sql_str
from .layout import (
    bundle_dir,
    checks_file,
    curate_stats_file,
    curated_file,
    dated_dirs,
    read_json,
    report_md,
    stage_stats_file,
    write_json,
)
from .registry import Registry
from .settings import CONFIG_DIR
from .taxonomy import load_taxonomy

log = logging.getLogger(__name__)

FORMAT_VERSION = 1
PLACES_FILE = "places.jsonl.gz"
PARQUET_FILE = "places.parquet"
SOURCES_FILE = "sources.json"
MANIFEST_FILE = "manifest.json"


class BundlePlaceSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str
    source_id: str
    licence: str
    fetched_at: str
    raw_ref: str


class BundlePlace(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    golden_id: str
    city_code: str
    name: str
    name_local: str | None
    name_en: str | None
    category: str
    tag: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    address: str | None
    website: str | None
    phone: str | None
    opening_hours: str | None
    wikidata_qid: str | None
    description: str | None
    score: float
    rank: int = Field(ge=1)
    n_sources: int = Field(ge=1)
    confidence: float | None
    wikidata_sitelinks: int | None
    wikivoyage_listed: bool | None
    sources: list[BundlePlaceSource] = Field(min_length=1)


class BundleSourceInfo(BaseModel):
    """A registry source as the Data page shows it."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    url: str
    licence: str
    licence_detail: str | None
    licence_urls: list[str]
    attribution: str
    terms_checked_on: str
    allowed_uses: list[str]
    enabled: bool
    version: str | None
    fetched_at: str | None
    staged_rows: int | None
    places: int


class BundleFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    sha256: str
    bytes: int
    rows: int | None = None


class BundleCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    status: Literal["pass", "fail", "warn", "info"]
    detail: str
    data: dict[str, Any] = Field(default_factory=dict)


class BundleChecks(BaseModel):
    model_config = ConfigDict(extra="forbid")

    passed: bool
    results: list[BundleCheck]


class BundleCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    places: int
    cities: int
    by_city: dict[str, int]
    by_category: dict[str, int]
    by_tag: dict[str, int]
    by_source: dict[str, int]
    with_licence: int
    with_sources: int


class BundleManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    format: int = FORMAT_VERSION
    bundle_date: str
    run_date: str
    created_at: str
    pipeline_version: str
    # Always the match stage's output: golden records.
    input: Literal["golden"]
    settings: dict[str, Any]
    files: list[BundleFile]
    counts: BundleCounts
    checks: BundleChecks
    evals: dict[str, Any] = Field(default_factory=dict)
    # Present when the enrich stage has run: counts, model and date of enrichment.jsonl.gz.
    enrichment: BundleEnrichmentSummary | None = None
    # Present only when the stay stages ran for this date.
    stay: BundleStay | None = None


# --- writing ------------------------------------------------------------------------------------


def _utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_places(parquet: Path) -> list[BundlePlace]:
    """The curated layer as bundle places, ordered by city and rank."""
    con = connect()
    out: list[BundlePlace] = []
    for r in rows(
        con,
        f"SELECT * FROM read_parquet({sql_str(parquet.as_posix())}) ORDER BY city_code, city_rank, place_id",
    ):
        signals = r["signals"] or {}
        out.append(
            BundlePlace(
                id=r["place_id"],
                golden_id=r["golden_id"],
                city_code=r["city_code"],
                name=r["name"],
                name_local=r["name_local"],
                name_en=r["name_en"],
                category=r["category"],
                tag=r["tag"],
                lat=round(r["lat"], 7),
                lon=round(r["lon"], 7),
                address=r["address"],
                website=r["website"],
                phone=r["phone"],
                opening_hours=r["opening_hours"],
                wikidata_qid=r["wikidata_qid"],
                description=r["description"],
                score=r["score"],
                rank=r["city_rank"],
                n_sources=r["n_sources"],
                confidence=signals.get("confidence"),
                wikidata_sitelinks=signals.get("wikidata_sitelinks"),
                wikivoyage_listed=signals.get("wikivoyage_listed"),
                sources=[
                    BundlePlaceSource(
                        source=s["source"],
                        source_id=s["source_id"],
                        licence=s["licence"],
                        fetched_at=_utc(s["fetched_at"]) or "",
                        raw_ref=s["raw_ref"],
                    )
                    for s in r["sources"]
                ],
            )
        )
    con.close()
    return out


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_places(path: Path, places: Iterable[BundlePlace]) -> int:
    """Gzipped JSON Lines; mtime 0 so the same places always give the same bytes."""
    n = 0
    with open(path, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as gz:
        for p in places:
            gz.write((p.model_dump_json() + "\n").encode("utf-8"))
            n += 1
    return n


def read_places(path: Path) -> list[BundlePlace]:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return [BundlePlace.model_validate_json(line) for line in fh if line.strip()]


def source_infos(
    registry: Registry, places: list[BundlePlace], out: Path, date: str
) -> list[BundleSourceInfo]:
    """Every enabled registry source (and any other that has places), with its counts and freshness."""
    per_source: Counter[str] = Counter()
    latest: dict[str, str] = {}
    for p in places:
        for s in {s.source for s in p.sources}:
            per_source[s] += 1
        for s in p.sources:
            latest[s.source] = max(latest.get(s.source, ""), s.fetched_at)
    keys = [k for k, e in registry.sources.items() if e.enabled or per_source[k]]
    infos = []
    for key in keys:
        entry = registry.sources[key]
        stats_path = stage_stats_file(out, date, key)
        stats = read_json(stats_path) if stats_path.is_file() else {}
        infos.append(
            BundleSourceInfo(
                id=key,
                name=entry.name,
                url=entry.url,
                licence=entry.licence,
                licence_detail=entry.licence_detail,
                licence_urls=entry.licence_urls,
                attribution=entry.attribution,
                terms_checked_on=entry.terms_checked_on.isoformat(),
                allowed_uses=entry.allowed_uses,
                enabled=entry.enabled,
                version=stats.get("version"),
                fetched_at=latest.get(key) or stats.get("fetched_at"),
                staged_rows=stats.get("staged_rows"),
                places=per_source[key],
            )
        )
    return infos


def previous_manifest(out: Path, date: str) -> dict[str, Any] | None:
    """The newest earlier bundle's manifest that passed its checks."""
    for d in reversed([d for d in dated_dirs(out / "bundles") if d < date]):
        path = bundle_dir(out, d) / MANIFEST_FILE
        if path.is_file():
            data = read_json(path)
            if data.get("checks", {}).get("passed"):
                return data
    return None


def build_bundle(
    out: Path,
    date: str,
    *,
    registry: Registry,
    config: CurationConfig | None = None,
    config_dir: Path = CONFIG_DIR,
    created_at: datetime | None = None,
    parquet: bool = True,
    stay: bool = True,
) -> tuple[Path, BundleManifest]:
    """Write bundles/<date>/ from curated/<date>/. The bundle is written even when a check fails (so it can
    be inspected), but then its manifest says `passed: false` and the load job skips it."""
    cfg = config or load_curation_config(config_dir)
    curated = curated_file(out, date)
    if not curated.is_file():
        raise FileNotFoundError(f"No curated places for {date} ({curated}); run curate first")
    curate_stats = read_json(curate_stats_file(out, date))
    places = load_places(curated)

    upstream = None
    if checks_file(out, date).is_file():
        upstream = read_json(checks_file(out, date))

    enrichment = load_enrichment(out, date, [p.id for p in places])

    ctx = BundleCheckContext(
        registry=registry,
        cities={c.code: c for c in load_cities(config_dir=config_dir)},
        countries=load_countries(config_dir),
        taxonomy=load_taxonomy(config_dir),
        config=cfg,
        curate_stats=curate_stats,
        upstream_checks=upstream,
        previous=previous_manifest(out, date),
        enrichment=enrichment,
    )
    results: list[CheckResult] = run_bundle_checks(places, ctx)
    stay_data = build_stay(out, date, registry=registry, config_dir=config_dir) if stay else None
    if stay_data:
        results += stay_data.results
    passed = not any(r.status == "fail" for r in results)

    target = bundle_dir(out, date)
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    n_places = write_places(target / PLACES_FILE, places)
    files = [BundleFile(name=PLACES_FILE, sha256=_sha256(target / PLACES_FILE), bytes=0, rows=n_places)]
    if enrichment is not None:
        n_enriched = write_enrichment_jsonl(target / ENRICHMENT_FILE, enrichment.rows)
        files.append(BundleFile(name=ENRICHMENT_FILE, sha256="", bytes=0, rows=n_enriched))
        if parquet:
            write_enrichment_parquet(target / ENRICHMENT_PARQUET_FILE, enrichment)
            files.append(BundleFile(name=ENRICHMENT_PARQUET_FILE, sha256="", bytes=0, rows=n_enriched))
    infos = source_infos(registry, places, out, date)
    write_json(target / SOURCES_FILE, [i.model_dump(mode="json") for i in infos])
    files.append(BundleFile(name=SOURCES_FILE, sha256="", bytes=0, rows=len(infos)))
    if parquet:
        shutil.copyfile(curated, target / PARQUET_FILE)
        files.append(BundleFile(name=PARQUET_FILE, sha256="", bytes=0, rows=n_places))
    if stay_data:
        n_units = write_jsonl_gz(target / STAY_UNIT_FILE, stay_data.units)
        n_hotels = write_jsonl_gz(target / HOTELS_FILE, stay_data.hotels)
        files += [
            BundleFile(name=STAY_UNIT_FILE, sha256="", bytes=0, rows=n_units),
            BundleFile(name=HOTELS_FILE, sha256="", bytes=0, rows=n_hotels),
        ]
        if parquet:
            copies = write_parquet_copies(out, date, target, stay_data.hotels)
            for name, n in zip(copies, (n_units, n_hotels), strict=True):
                files.append(BundleFile(name=name, sha256="", bytes=0, rows=n))
    for f in files:
        path = target / f.name
        f.sha256, f.bytes = _sha256(path), path.stat().st_size

    by_source: Counter[str] = Counter()
    for p in places:
        for s in {s.source for s in p.sources}:
            by_source[s] += 1
    counts = BundleCounts(
        places=len(places),
        cities=len({p.city_code for p in places}),
        by_city=dict(sorted(Counter(p.city_code for p in places).items())),
        by_category=dict(sorted(Counter(p.category for p in places).items())),
        by_tag=dict(sorted(Counter(p.tag for p in places).items())),
        by_source=dict(sorted(by_source.items())),
        with_licence=sum(1 for p in places if all(s.licence.strip() for s in p.sources)),
        with_sources=sum(1 for p in places if p.sources),
    )
    manifest = BundleManifest(
        bundle_date=date,
        run_date=date,
        created_at=_utc(created_at or datetime.now(UTC)) or "",
        pipeline_version=__version__,
        input=curate_stats["input"],
        settings={
            "budget": cfg.budget.model_dump(),
            "min_confidence": cfg.min_confidence,
            "mix": cfg.mix.model_dump(),
        },
        files=files,
        counts=counts,
        checks=BundleChecks(passed=passed, results=[BundleCheck(**asdict(r)) for r in results]),
        enrichment=summarise(enrichment) if enrichment is not None else None,
        stay=stay_data.section if stay_data else None,
    )
    if enrichment is not None and (scores := eval_scores(out, models_by_use(enrichment))):
        manifest.evals["enrich"] = scores
    document = manifest.model_dump(mode="json")
    if document["stay"] is None:
        del document["stay"]  # bundles without stay data keep the format they always had
    write_json(target / MANIFEST_FILE, document)
    for r in results:
        log.log(
            logging.ERROR if r.status == "fail" else logging.INFO, "[%s] %s: %s", r.status, r.name, r.detail
        )
    log.info("bundle %s: %s places, checks %s", target, f"{len(places):,}", "passed" if passed else "FAILED")
    return target, manifest


def verify_bundle(path: Path) -> BundleManifest:
    """Re-read a bundle folder and check each file's size and checksum against its manifest."""
    manifest = BundleManifest.model_validate(read_json(path / MANIFEST_FILE))
    for f in manifest.files:
        actual = _sha256(path / f.name)
        if actual != f.sha256:
            raise ValueError(f"{f.name}: checksum {actual} does not match the manifest ({f.sha256})")
    return manifest


def bundle_report(manifest: BundleManifest) -> str:
    """The bundle's part of the Markdown run report."""
    c = manifest.counts
    source = "match output"
    lines = [
        "",
        f"## Bundle {manifest.bundle_date}",
        "",
        f"Checks: **{'passed' if manifest.checks.passed else 'FAILED'}**. {c.places:,} curated places "
        f"in {c.cities} cities (input: {source}). Graph budget {manifest.settings['budget']['total']:,}.",
        "",
        "| Colour tag | Places | Share |",
        "|---|---:|---:|",
    ]
    lines += [
        f"| {t} | {n:,} | {n / c.places:.1%} |" for t, n in sorted(c.by_tag.items(), key=lambda kv: -kv[1])
    ]
    if manifest.enrichment:
        e = manifest.enrichment
        lines += [
            "",
            f"Enrichment: {e.places:,} of {c.places:,} places ({e.with_summary:,} AI summaries) by "
            f"{', '.join(e.models)}, newest answer {e.enriched_at}.",
        ]
    lines += ["", "| Source | Places citing it |", "|---|---:|"]
    lines += [f"| {s} | {n:,} |" for s, n in sorted(c.by_source.items())]
    lines += ["", "| Check | Status | Detail |", "|---|---|---|"]
    pipe = chr(92) + "|"
    lines += [
        f"| {r.name} | {r.status if r.status != 'fail' else '**FAIL**'} | {r.detail.replace('|', pipe)} |"
        for r in manifest.checks.results
        if not r.name.startswith("staging.") or r.status in ("fail", "warn")
    ]
    return "\n".join(lines) + "\n"


def append_bundle_report(out: Path, date: str, manifest: BundleManifest) -> None:
    """Add the bundle section to the run report and to the CI run summary ($GITHUB_STEP_SUMMARY)."""
    text = bundle_report(manifest)
    md = report_md(out, date)
    if md.is_file():
        with open(md, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
