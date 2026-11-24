"""Stage 4, curate: rank golden records and choose the places that go into the graph.

docs/data-platform-spec.md, "Ranking and curation":

* `score` = sources agreeing + log of Wikidata sitelinks + listed in Wikivoyage + source confidence +
  category weight (sights outrank chain cafes), see config/curation.yaml and config/category_weight.csv.
* The graph gets about 8,000 places in total. Each city's share comes from its size (how many places
  it has) and how many nights the seeded routes spend there, clamped to a floor and a cap.
* Inside a city the best places win, but no category or colour tag may take more than its share of the
  city's budget, so the mix is not 76% food.
* Every place keeps its list of source records and their licences.
"""

from __future__ import annotations

import csv
import logging
import math
import os
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import duckdb
import yaml
from pydantic import BaseModel, ConfigDict, Field

from .duck import connect, rows, run, sql_str
from .golden import GOLDEN_COLUMNS, from_matched, source_priority_sql
from .layout import (
    curate_stats_file,
    curated_file,
    golden_file,
    latest_matched_date,
    latest_staging_date,
    read_json,
    staged_file,
    staged_sources,
    write_json,
)
from .provisional import PROVISIONAL_RADIUS_M, build_provisional_golden
from .settings import CONFIG_DIR, SEED_DIR
from .taxonomy import load_taxonomy

log = logging.getLogger(__name__)

BUDGET_ENV = "CURATE_BUDGET"


class BudgetConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total: int = Field(gt=0)
    floor: int = Field(ge=0)
    cap: int = Field(gt=0)


class SizeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nights_divisor: float = Field(gt=0)


class ScoreConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agree: float
    agree_max_sources: int = Field(ge=1)
    notability: float
    voyage: float
    confidence: float
    default_confidence: float = Field(ge=0, le=1)
    website: float
    chain_penalty: float


class MixConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    default_category_max_share: float = Field(gt=0, le=1)
    tag_target_share: dict[str, float]
    tag_max_share: dict[str, float]
    tag_share_slack: float = Field(ge=0)


class CategoryRule(BaseModel):
    category: str
    tag: str
    weight: float
    max_share: float | None
    chain_sensitive: bool


class CurationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    budget: BudgetConfig
    size: SizeConfig
    score: ScoreConfig
    min_confidence: float = Field(ge=0, le=1)
    mix: MixConfig
    categories: dict[str, CategoryRule] = Field(default_factory=dict)

    def category_max_share(self, category: str) -> float:
        rule = self.categories.get(category)
        return rule.max_share if rule and rule.max_share is not None else self.mix.default_category_max_share


def load_curation_config(config_dir: Path = CONFIG_DIR, *, total: int | None = None) -> CurationConfig:
    with open(config_dir / "curation.yaml", encoding="utf-8") as fh:
        cfg = CurationConfig.model_validate(yaml.safe_load(fh))
    override = (
        total if total is not None else (int(os.environ[BUDGET_ENV]) if os.environ.get(BUDGET_ENV) else None)
    )
    if override is not None:
        cfg.budget.total = override
    taxonomy = load_taxonomy(config_dir)
    with open(config_dir / "category_weight.csv", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(line for line in fh if line.strip() and not line.startswith("#")):
            category = row["category"].strip()
            if category not in taxonomy:
                raise ValueError(f"category_weight.csv: {category!r} is not in taxonomy.csv")
            if category in cfg.categories:
                raise ValueError(f"category_weight.csv: duplicate row for {category!r}")
            cfg.categories[category] = CategoryRule(
                category=category,
                tag=taxonomy[category].tag,
                weight=float(row["weight"]),
                max_share=float(row["max_share"]) if row["max_share"].strip() else None,
                chain_sensitive=row["chain_sensitive"].strip().lower() == "true",
            )
    missing = sorted(set(taxonomy) - set(cfg.categories))
    if missing:
        raise ValueError(f"category_weight.csv has no row for taxonomy categories: {missing}")
    tags = {t.tag for t in taxonomy.values()}
    for name, shares in (
        ("tag_target_share", cfg.mix.tag_target_share),
        ("tag_max_share", cfg.mix.tag_max_share),
    ):
        unknown = sorted(set(shares) - tags)
        if unknown:
            raise ValueError(f"curation.yaml: unknown colour tags {unknown} in mix.{name}")
    if sum(cfg.mix.tag_target_share.values()) > 1.0 + 1e-9:
        raise ValueError("curation.yaml: mix.tag_target_share adds up to more than 1")
    return cfg


# --- city budgets -------------------------------------------------------------------------------


def nights_by_city(seed_dir: Path = SEED_DIR) -> dict[str, int]:
    """Total nights the seeded routes spend in each city (a city on no route is absent)."""
    nights: dict[str, int] = defaultdict(int)
    trip_file = seed_dir / "trip.json"
    if not trip_file.is_file():
        return {}
    for name in read_json(trip_file).get("routes", []):
        for stop in read_json(seed_dir / name).get("stops", []):
            nights[stop["city"]] += int(stop.get("nights") or 0)
    return dict(nights)


def city_weight(supply: int, nights: int, nights_divisor: float) -> float:
    return math.log1p(max(supply, 0)) * (1 + nights / nights_divisor)


def allocate_budgets(
    weights: dict[str, float], supply: dict[str, int], total: int, floor: int, cap: int
) -> dict[str, int]:
    """Split `total` over cities in proportion to `weights`, each between min(floor, supply) and
    min(cap, supply), as whole numbers adding up to `total` (or the nearest the bounds allow)."""
    lo = {c: min(floor, supply[c]) for c in weights}
    hi = {c: min(cap, supply[c]) for c in weights}
    if sum(hi.values()) <= total:
        return hi
    if sum(lo.values()) >= total:
        return lo

    def share(lam: float) -> dict[str, float]:
        return {c: min(max(lam * weights[c], lo[c]), hi[c]) for c in weights}

    low, high = 0.0, 1.0
    while sum(share(high).values()) < total:
        high *= 2
    for _ in range(100):
        mid = (low + high) / 2
        if sum(share(mid).values()) < total:
            low = mid
        else:
            high = mid
    values = share(high)
    alloc = {c: math.floor(v + 1e-9) for c, v in values.items()}
    remainder = total - sum(alloc.values())
    # Largest fractional parts first; cities at their cap cannot take more. Ties: city code.
    order = sorted(weights, key=lambda c: (-(values[c] - alloc[c]), c))
    for c in order:
        if remainder <= 0:
            break
        if alloc[c] < hi[c]:
            alloc[c] += 1
            remainder -= 1
    return alloc


# --- choosing places inside a city --------------------------------------------------------------


@dataclass(frozen=True)
class Candidate:
    place_id: str
    category: str
    tag: str
    score: float


def select_city(candidates: list[Candidate], budget: int, cfg: CurationConfig) -> list[Candidate]:
    """The best `budget` candidates (given best first) with a mix of colour tags.

    1. Each tag gets its target share of the budget: its best candidates, no category over its share.
    2. The rest is filled by score with no tag over its max share and no category over its share.
    3. If the budget is still unfilled (a small town with few sights) the limits ease: category shares
       doubled, then dropped, then tag max shares dropped too.
    """
    chosen: list[Candidate] = []
    taken: set[str] = set()
    per_category: Counter[str] = Counter()
    per_tag: Counter[str] = Counter()

    def cat_cap(cand: Candidate, scale: float) -> float:
        if math.isinf(scale):
            return math.inf
        return max(1, math.ceil(cfg.category_max_share(cand.category) * budget * scale))

    def take(cand: Candidate) -> None:
        chosen.append(cand)
        taken.add(cand.place_id)
        per_category[cand.category] += 1
        per_tag[cand.tag] += 1

    quota = {tag: math.floor(share * budget) for tag, share in cfg.mix.tag_target_share.items()}
    for cand in candidates:
        if len(chosen) >= budget:
            break
        if per_tag[cand.tag] < quota.get(cand.tag, 0) and per_category[cand.category] < cat_cap(cand, 1.0):
            take(cand)

    for scale, limit_tags in ((1.0, True), (2.0, True), (math.inf, True), (math.inf, False)):
        for cand in candidates:
            if len(chosen) >= budget:
                break
            if cand.place_id in taken or per_category[cand.category] >= cat_cap(cand, scale):
                continue
            tag_share = cfg.mix.tag_max_share.get(cand.tag)
            if (
                limit_tags
                and tag_share is not None
                and per_tag[cand.tag] >= max(1, math.ceil(tag_share * budget))
            ):
                continue
            take(cand)
    return sorted(chosen, key=lambda c: (-c.score, c.place_id))


# --- the stage ----------------------------------------------------------------------------------


@dataclass
class CurateResult:
    date: str
    input: str  # "golden" or "staged"
    path: Path
    stats: dict[str, Any]


def _catrule_table(con: duckdb.DuckDBPyConnection, cfg: CurationConfig) -> None:
    run(con, "CREATE OR REPLACE TABLE catrule (category VARCHAR, tag VARCHAR, weight DOUBLE, chain BOOLEAN)")
    con.executemany(
        "INSERT INTO catrule VALUES (?, ?, ?, ?)",
        [[r.category, r.tag, r.weight, r.chain_sensitive] for r in cfg.categories.values()],
    )


def _scored_view_sql(cfg: CurationConfig) -> str:
    s = cfg.score
    anchor = (
        "list_sort(list_transform(g.sources, lambda x: "
        f"printf('%02d:%s:%s', {source_priority_sql('x.source')}, x.source, x.source_id)))[1]"
    )
    return f"""
    CREATE OR REPLACE VIEW scored AS
    WITH base AS (
      SELECT g.*, r.tag, r.weight AS cat_weight, r.chain,
             len(list_distinct(list_transform(g.sources, lambda x: x.source))) AS n_sources,
             'cat-' || substr(sha256(coalesce('wikidata:' || g.wikidata_qid, {anchor})), 1, 16) AS place_id
      FROM golden g JOIN catrule r ON r.category = g.category
      WHERE g.signals.confidence IS NULL OR g.signals.confidence >= {cfg.min_confidence}
    )
    SELECT *,
      {s.agree} * (least(n_sources, {s.agree_max_sources}) - 1) AS p_agree,
      {s.notability} * ln(1 + coalesce(signals.wikidata_sitelinks, 0)) AS p_notability,
      {s.voyage} * CASE WHEN coalesce(signals.wikivoyage_listed, false) THEN 1 ELSE 0 END AS p_voyage,
      {s.confidence} * coalesce(signals.confidence, {s.default_confidence}) AS p_confidence,
      cat_weight AS p_category,
      {s.website} * CASE WHEN website IS NOT NULL AND website <> '' THEN 1 ELSE 0 END AS p_website,
      -{s.chain_penalty} * CASE WHEN chain AND signals.brand_wikidata IS NOT NULL THEN 1 ELSE 0 END AS p_chain,
      round(p_agree + p_notability + p_voyage + p_confidence + p_category + p_website + p_chain, 4) AS score
    FROM base
    """


def load_golden(
    con: duckdb.DuckDBPyConnection,
    out: Path,
    date: str,
    *,
    source: Literal["auto", "golden", "staged"] = "auto",
) -> tuple[str, dict[str, Any]]:
    """Create the `golden` table from the match output, or (no match output) from staged rows."""
    gfile = golden_file(out, date)
    if source in ("auto", "golden") and gfile.is_file():
        staged = [staged_file(out, date, s).as_posix() for s in staged_sources(out, date)]
        return "golden", {"golden_rows": from_matched(con, gfile.as_posix(), staged)}
    if source == "golden":
        raise FileNotFoundError(f"No golden records for {date} ({gfile}); run the match stage first")
    sources = staged_sources(out, date)
    if not sources:
        raise FileNotFoundError(f"No golden or staged data for {date}; run match or stage first")
    log.warning(
        "no golden records for %s: using staged rows, each its own golden record "
        "(rows of two sources with the same name within %d m are merged)",
        date,
        PROVISIONAL_RADIUS_M,
    )
    return "staged", build_provisional_golden(con, [staged_file(out, date, s) for s in sources])


def curate(
    out: Path,
    date: str,
    *,
    config: CurationConfig | None = None,
    config_dir: Path = CONFIG_DIR,
    seed_dir: Path = SEED_DIR,
    source: Literal["auto", "golden", "staged"] = "auto",
) -> CurateResult:
    cfg = config or load_curation_config(config_dir)
    taxonomy = load_taxonomy(config_dir)
    con = connect()
    kind, input_stats = load_golden(con, out, date, source=source)
    _catrule_table(con, cfg)
    run(con, _scored_view_sql(cfg))

    # One place per id (two golden records sharing a Wikidata QID would be a match-stage bug), the best
    # `cap` of each city's categories (no category can take more than the cap), best first.
    run(
        con,
        f"""CREATE TABLE pool AS
            SELECT * FROM scored
            QUALIFY row_number() OVER (PARTITION BY place_id ORDER BY score DESC, golden_id) = 1
               AND row_number() OVER (PARTITION BY city_code, category
                                      ORDER BY score DESC, signals.confidence DESC NULLS LAST, name, place_id)
                   <= {cfg.budget.cap}""",
    )
    supply = {
        r["city_code"]: r["n"]
        for r in rows(
            con, "SELECT city_code, count(*) AS n FROM scored GROUP BY city_code ORDER BY city_code"
        )
    }
    nights = nights_by_city(seed_dir)
    weights = {c: city_weight(n, nights.get(c, 0), cfg.size.nights_divisor) for c, n in supply.items()}
    budgets = allocate_budgets(weights, supply, cfg.budget.total, cfg.budget.floor, cfg.budget.cap)

    by_city: dict[str, list[Candidate]] = defaultdict(list)
    for r in rows(
        con,
        "SELECT city_code, place_id, category, tag, score FROM pool "
        "ORDER BY city_code, score DESC, signals.confidence DESC NULLS LAST, name, place_id",
    ):
        by_city[r["city_code"]].append(Candidate(r["place_id"], r["category"], r["tag"], r["score"]))
    run(con, "CREATE TABLE sel (place_id VARCHAR, city_rank INTEGER)")
    selected: dict[str, list[Candidate]] = {}
    for city, candidates in sorted(by_city.items()):
        picked = select_city(candidates, budgets.get(city, 0), cfg)
        selected[city] = picked
        con.executemany(
            "INSERT INTO sel VALUES (?, ?)", [[c.place_id, i] for i, c in enumerate(picked, start=1)]
        )

    columns = ", ".join(f"p.{c}" for c in GOLDEN_COLUMNS)
    run(
        con,
        f"""CREATE TABLE curated AS
            SELECT p.place_id, {columns}, p.tag, p.n_sources, p.score, p.city_rank,
                   p.p_agree, p.p_notability, p.p_voyage, p.p_confidence, p.p_category, p.p_website, p.p_chain
            FROM (SELECT pool.*, sel.city_rank FROM pool JOIN sel USING (place_id)) p
            ORDER BY p.city_code, p.city_rank""",
    )
    path = curated_file(out, date)
    path.parent.mkdir(parents=True, exist_ok=True)
    run(con, f"COPY curated TO {sql_str(path.as_posix())} (FORMAT PARQUET, COMPRESSION ZSTD)")

    by_category = dict(sorted(Counter(c.category for cs in selected.values() for c in cs).items()))
    by_tag = dict(sorted(Counter(c.tag for cs in selected.values() for c in cs).items()))
    total_selected = sum(len(v) for v in selected.values())
    stats: dict[str, Any] = {
        "run_date": date,
        "input": kind,
        "input_stats": input_stats,
        "budget": cfg.budget.model_dump(),
        "eligible_places": sum(supply.values()),
        "selected_places": total_selected,
        "cities": {
            city: {
                "eligible": supply.get(city, 0),
                "nights": nights.get(city, 0),
                "budget": budgets.get(city, 0),
                "selected": len(selected.get(city, [])),
            }
            for city in sorted(supply)
        },
        "by_category": by_category,
        "by_tag": by_tag,
        "tag_share": {t: round(n / total_selected, 4) for t, n in by_tag.items()} if total_selected else {},
        "taxonomy_categories": len(taxonomy),
        "provisional_merge": kind == "staged",
    }
    write_json(curate_stats_file(out, date), stats)
    con.close()
    log.info(
        "curated %s places in %d cities from %s (budget %s); %s",
        f"{total_selected:,}",
        sum(1 for v in selected.values() if v),
        f"{stats['eligible_places']:,} eligible",
        cfg.budget.total,
        ", ".join(f"{t} {s:.0%}" for t, s in stats["tag_share"].items()),
    )
    return CurateResult(date=date, input=kind, path=path, stats=stats)


def default_date(out: Path) -> str | None:
    """The run to curate when --date is not given: the newest golden date, else the newest staging date."""
    return latest_matched_date(out) or latest_staging_date(out)
