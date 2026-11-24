"""Quality checks on a curated bundle (docs/data-platform-spec.md, Feature 7). Any failure marks the bundle
`passed: false`, so the load job skips it and the app keeps its last good data."""

from __future__ import annotations

import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from .checks import CheckResult
from .cities import City, Country, haversine_km
from .registry import Registry
from .taxonomy import Category

if TYPE_CHECKING:
    from .bundle import BundlePlace
    from .bundle_enrichment import EnrichmentData
    from .curation import CurationConfig

DUPLICATE_RADIUS_M = 50.0
RADIUS_SLACK_KM = 0.01
COUNTRY_BBOX_MARGIN_DEG = 0.05
ROW_COUNT_TOLERANCE = 0.40


@dataclass
class BundleCheckContext:
    registry: Registry
    cities: dict[str, City]
    countries: dict[str, Country]
    taxonomy: dict[str, Category]
    config: CurationConfig
    curate_stats: dict[str, Any]
    upstream_checks: dict[str, Any] | None = None  # reports/<date>.checks.json from the check stage
    previous: dict[str, Any] | None = None  # the last passed bundle's manifest
    enrichment: EnrichmentData | None = None  # the enrich stage's rows for these places, when there are any


def _name_key(name: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", name).casefold().split())


def check_not_empty(places: list[BundlePlace], ctx: BundleCheckContext) -> list[CheckResult]:
    if not places:
        return [CheckResult("places.not_empty", "fail", "the bundle has no places")]
    return [
        CheckResult(
            "places.not_empty",
            "pass",
            f"{len(places):,} places in {len({p.city_code for p in places})} cities",
        )
    ]


def check_ids(places: list[BundlePlace], ctx: BundleCheckContext) -> list[CheckResult]:
    counts = Counter(p.id for p in places)
    dupes = sorted(i for i, n in counts.items() if n > 1)
    if dupes:
        return [CheckResult("places.unique_ids", "fail", f"{len(dupes)} duplicate ids, e.g. {dupes[:3]}")]
    return [CheckResult("places.unique_ids", "pass", "every place id is unique")]


def check_provenance(places: list[BundlePlace], ctx: BundleCheckContext) -> list[CheckResult]:
    no_sources = [p.id for p in places if not p.sources]
    no_licence = [p.id for p in places if any(not s.licence.strip() for s in p.sources)]
    unknown, unregistered = set(), set()
    for p in places:
        for s in p.sources:
            entry = ctx.registry.sources.get(s.source)
            if entry is None:
                unknown.add(s.source)
            else:
                for licence in (part.strip() for part in s.licence.split(" AND ")):
                    if licence and licence not in entry.licence_ids():
                        unregistered.add(f"{s.source}:{licence}")
    results = []
    bad = len(no_sources) + len(no_licence)
    results.append(
        CheckResult(
            "provenance.licence",
            "fail",
            f"{len(no_sources)} places without sources, {len(no_licence)} with a source without a licence",
        )
        if bad
        else CheckResult(
            "provenance.licence",
            "pass",
            f"all {len(places):,} places keep their source ids and a licence for each",
        )
    )
    results.append(
        CheckResult(
            "provenance.registered",
            "fail",
            f"sources or licences not in sources.yaml: {sorted(unknown | unregistered)}",
        )
        if unknown or unregistered
        else CheckResult("provenance.registered", "pass", "every source and licence is in sources.yaml")
    )
    return results


def check_taxonomy(places: list[BundlePlace], ctx: BundleCheckContext) -> list[CheckResult]:
    bad = sorted({p.category for p in places if p.category not in ctx.taxonomy})
    wrong_tag = sorted(
        {p.id for p in places if p.category in ctx.taxonomy and p.tag != ctx.taxonomy[p.category].tag}
    )
    if bad or wrong_tag:
        return [
            CheckResult(
                "categories.in_taxonomy",
                "fail",
                f"categories not in taxonomy.csv: {bad}; {len(wrong_tag)} with the wrong colour tag",
            )
        ]
    return [
        CheckResult(
            "categories.in_taxonomy",
            "pass",
            f"{len({p.category for p in places})} taxonomy categories in use",
        )
    ]


def check_coordinates(places: list[BundlePlace], ctx: BundleCheckContext) -> list[CheckResult]:
    outside, unknown = [], []
    for p in places:
        city = ctx.cities.get(p.city_code)
        if city is None:
            unknown.append(p.id)
        elif haversine_km(p.lat, p.lon, city.lat, city.lon) > city.radius_km + RADIUS_SLACK_KM:
            outside.append(p.id)
    results = [
        CheckResult(
            "coordinates.city_radius",
            "fail",
            f"{len(outside)} places outside their city's radius, {len(unknown)} in unknown cities",
            {"examples": (outside + unknown)[:5]},
        )
        if outside or unknown
        else CheckResult("coordinates.city_radius", "pass", "all places inside their city's radius")
    ]
    m = COUNTRY_BBOX_MARGIN_DEG
    out_country = []
    for p in places:
        city = ctx.cities.get(p.city_code)
        box = ctx.countries.get(city.country) if city else None
        if box and not (
            box.min_lon - m <= p.lon <= box.max_lon + m and box.min_lat - m <= p.lat <= box.max_lat + m
        ):
            out_country.append(p.id)
    results.append(
        CheckResult(
            "coordinates.country_bbox",
            "fail",
            f"{len(out_country)} places outside their country's bounding box",
            {"examples": out_country[:5]},
        )
        if out_country
        else CheckResult("coordinates.country_bbox", "pass", "all places inside their country's bounding box")
    )
    return results


def check_duplicates(places: list[BundlePlace], ctx: BundleCheckContext) -> list[CheckResult]:
    """No two places in a city within 50 m with the same name (spec: golden records are not duplicated)."""
    groups: dict[tuple[str, str], list[BundlePlace]] = defaultdict(list)
    for p in places:
        groups[(p.city_code, _name_key(p.name))].append(p)
    pairs = []
    for group in groups.values():
        for i, a in enumerate(group):
            for b in group[i + 1 :]:
                if haversine_km(a.lat, a.lon, b.lat, b.lon) * 1000 <= DUPLICATE_RADIUS_M:
                    pairs.append((a.id, b.id))
    if pairs:
        return [
            CheckResult(
                "duplicates.name_50m",
                "fail",
                f"{len(pairs)} pairs of places with the same name within {DUPLICATE_RADIUS_M:.0f} m",
                {"examples": pairs[:5]},
            )
        ]
    return [
        CheckResult(
            "duplicates.name_50m",
            "pass",
            f"no two places with the same name within {DUPLICATE_RADIUS_M:.0f} m",
        )
    ]


def check_budget(places: list[BundlePlace], ctx: BundleCheckContext) -> list[CheckResult]:
    cfg = ctx.config.budget
    per_city = Counter(p.city_code for p in places)
    over_cap = {c: n for c, n in per_city.items() if n > cfg.cap}
    # A city may be short of its floor only when it has fewer eligible places than the floor.
    cities_stats = ctx.curate_stats.get("cities", {})
    under_floor = {
        c: n
        for c, n in per_city.items()
        if n
        < min(
            cfg.floor,
            cities_stats.get(c, {}).get("eligible", cfg.floor),
            cities_stats.get(c, {}).get("budget", cfg.floor),
        )
    }
    floors = (
        sum(min(cfg.floor, s.get("eligible", cfg.floor)) for s in cities_stats.values())
        if cities_stats
        else 0
    )
    limit = max(cfg.total, floors)
    results = []
    results.append(
        CheckResult("budget.total", "fail", f"{len(places):,} places is over the graph budget of {limit:,}")
        if len(places) > limit
        else CheckResult(
            "budget.total", "pass", f"{len(places):,} places within the graph budget of {limit:,}"
        )
    )
    results.append(
        CheckResult(
            "budget.per_city",
            "fail",
            f"over the cap of {cfg.cap}: {over_cap}; under the floor of {cfg.floor}: {under_floor}",
        )
        if over_cap or under_floor
        else CheckResult(
            "budget.per_city", "pass", f"every city within its floor of {cfg.floor} and cap of {cfg.cap}"
        )
    )
    return results


def check_mix(places: list[BundlePlace], ctx: BundleCheckContext) -> list[CheckResult]:
    """The category mix: no colour tag far above its share (the spec's example: not 76% food)."""
    if not places:
        return []
    mix = ctx.config.mix
    tags = Counter(p.tag for p in places)
    shares = {t: n / len(places) for t, n in sorted(tags.items())}
    over = {
        t: round(s, 3)
        for t, s in shares.items()
        if t in mix.tag_max_share and s > mix.tag_max_share[t] + mix.tag_share_slack
    }
    detail = "share by colour tag: " + ", ".join(f"{t} {s:.0%}" for t, s in shares.items())
    if over:
        return [CheckResult("mix.tag_share", "fail", f"{detail}; over the limit: {over}")]
    return [CheckResult("mix.tag_share", "pass", detail)]


def check_upstream(places: list[BundlePlace], ctx: BundleCheckContext) -> list[CheckResult]:
    up = ctx.upstream_checks
    if up is None:
        return [CheckResult("staging.checks", "warn", "no staging check results found for this run")]
    results = [
        CheckResult(
            "staging.checks",
            "pass" if up.get("passed") else "fail",
            "the staging quality checks " + ("passed" if up.get("passed") else "FAILED"),
        )
    ]
    results += [CheckResult(f"staging.{r['name']}", r["status"], r["detail"]) for r in up.get("results", [])]
    return results


def check_previous(places: list[BundlePlace], ctx: BundleCheckContext) -> list[CheckResult]:
    prev = (ctx.previous or {}).get("counts", {}).get("places")
    if not prev:
        return [
            CheckResult("places.vs_previous", "info", "no previous bundle; counts recorded as the baseline")
        ]
    change = (len(places) - prev) / prev
    if abs(change) > ROW_COUNT_TOLERANCE:
        return [
            CheckResult(
                "places.vs_previous",
                "warn",
                f"{len(places):,} places is {change:+.0%} against the last bundle ({prev:,})",
            )
        ]
    return [
        CheckResult(
            "places.vs_previous",
            "pass",
            f"{len(places):,} places, {change:+.0%} against the last bundle ({prev:,})",
        )
    ]


def check_enrichment_provenance(places: list[BundlePlace], ctx: BundleCheckContext) -> list[CheckResult]:
    """A summary in the bundle must say it was written by AI (provenance.summary_ai, an AI label, the model)."""
    if ctx.enrichment is None:
        return []
    from .bundle_enrichment import check_enrichment

    return check_enrichment(ctx.enrichment.rows, len(places), ctx.enrichment.dropped)


CHECKS = [
    check_not_empty,
    check_ids,
    check_provenance,
    check_taxonomy,
    check_coordinates,
    check_duplicates,
    check_budget,
    check_mix,
    check_previous,
    check_enrichment_provenance,
    check_upstream,
]


def run_bundle_checks(places: list[BundlePlace], ctx: BundleCheckContext) -> list[CheckResult]:
    results: list[CheckResult] = []
    for check in CHECKS:
        try:
            results.extend(check(places, ctx))
        except Exception as exc:  # a crashing check is a failed check
            results.append(CheckResult(check.__name__, "fail", f"check crashed: {exc}"))
    return results
