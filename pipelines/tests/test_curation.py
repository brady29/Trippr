"""Curation: city budgets, the category mix, ranking, provenance and stable ids."""

from __future__ import annotations

import shutil
from collections import Counter
from pathlib import Path

import duckdb
import pytest

from trippr_data.curation import (
    Candidate,
    allocate_budgets,
    city_weight,
    curate,
    load_curation_config,
    nights_by_city,
    select_city,
)
from trippr_data.duck import connect, run
from trippr_data.layout import curated_file, golden_file
from trippr_data.match import match
from trippr_data.settings import SEED_DIR
from trippr_data.taxonomy import load_taxonomy

from .conftest import FIXTURE_DATE


def small_config(total: int = 60, floor: int = 5, cap: int = 40):
    cfg = load_curation_config(total=total)
    cfg.budget.floor, cfg.budget.cap = floor, cap
    return cfg


# --- config -------------------------------------------------------------------------------------


def test_every_taxonomy_category_has_a_weight():
    cfg = load_curation_config()
    assert set(cfg.categories) == set(load_taxonomy())
    assert cfg.budget.total == 8000 and cfg.budget.floor == 20 and cfg.budget.cap == 300
    # Sights outrank chain cafes.
    assert (
        cfg.categories["viewpoint"].weight
        > cfg.categories["restaurant"].weight
        > cfg.categories["cafe"].weight
    )


def test_budget_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv("CURATE_BUDGET", "1234")
    assert load_curation_config().budget.total == 1234


# --- budgets ------------------------------------------------------------------------------------


def test_budgets_add_up_and_respect_floor_and_cap():
    supply = {"AAA": 50_000, "BBB": 20_000, "CCC": 400, "DDD": 12, "EEE": 3_000, "FFF": 90_000}
    nights = {"AAA": 15, "BBB": 4, "FFF": 0}
    weights = {c: city_weight(n, nights.get(c, 0), 5.0) for c, n in supply.items()}
    budgets = allocate_budgets(weights, supply, total=700, floor=20, cap=300)
    assert sum(budgets.values()) == 700
    assert budgets["DDD"] == 12  # fewer places than the floor: all of them
    assert all(20 <= b <= 300 for c, b in budgets.items() if c != "DDD")
    assert budgets["AAA"] > budgets["FFF"]  # nights count: more nights beats more places
    assert budgets["AAA"] > budgets["EEE"]


def test_budget_is_capped_and_the_rest_reshared():
    supply = {"BIG": 100_000, "MID": 5_000, "SMALL": 500}
    budgets = allocate_budgets({"BIG": 50.0, "MID": 5.0, "SMALL": 1.0}, supply, total=500, floor=20, cap=300)
    assert budgets["BIG"] == 300
    assert sum(budgets.values()) == 500
    assert budgets["SMALL"] >= 20


def test_budget_never_exceeds_what_exists():
    assert allocate_budgets({"A": 1.0, "B": 1.0}, {"A": 10, "B": 5}, total=1000, floor=20, cap=300) == {
        "A": 10,
        "B": 5,
    }


def test_budget_is_deterministic():
    supply = {f"C{i:02d}": 1000 + i for i in range(30)}
    weights = {c: 1.0 for c in supply}
    first = allocate_budgets(weights, supply, total=333, floor=5, cap=100)
    assert first == allocate_budgets(dict(reversed(weights.items())), supply, total=333, floor=5, cap=100)


def test_nights_come_from_the_seeded_routes():
    nights = nights_by_city(SEED_DIR)
    assert nights["TYO"] > nights["OSA"] > 0
    assert "NOWHERE" not in nights


# --- the mix ------------------------------------------------------------------------------------


def cand(i: int, category: str, tag: str, score: float) -> Candidate:
    return Candidate(f"id{i:04d}", category, tag, score)


def test_a_city_is_not_mostly_food():
    cfg = small_config()
    # 700 restaurants and cafes that all outscore 800 sights in eight categories: what the raw data looks like.
    candidates = [cand(i, "restaurant" if i % 2 else "cafe", "food", 10 - i / 1000) for i in range(700)]
    sights = [
        ("temple_shrine", "culture"), ("viewpoint", "nature"), ("museum", "culture"), ("park_garden", "nature"),
        ("landmark", "culture"), ("castle_palace", "culture"), ("historic_site", "culture"), ("hike", "nature"),
    ]  # fmt: skip
    candidates += [cand(1000 + i, *sights[i % 8], 3 - i / 1000) for i in range(800)]
    candidates.sort(key=lambda c: (-c.score, c.place_id))
    chosen = select_city(candidates, 100, cfg)
    assert len(chosen) == 100
    tags = Counter(c.tag for c in chosen)
    assert 15 <= tags["food"] <= 30
    assert Counter(c.category for c in chosen)["restaurant"] <= 12
    assert tags["culture"] + tags["nature"] >= 60


def test_category_limits_give_way_before_colour_limits():
    cfg = small_config()
    candidates = [cand(i, "restaurant" if i % 2 else "cafe", "food", 10 - i / 1000) for i in range(700)]
    candidates += [
        cand(
            1000 + i,
            "temple_shrine" if i % 2 else "viewpoint",
            "culture" if i % 2 else "nature",
            3 - i / 1000,
        )
        for i in range(100)
    ]
    candidates.sort(key=lambda c: (-c.score, c.place_id))
    chosen = select_city(candidates, 100, cfg)
    assert Counter(c.tag for c in chosen)["food"] == 30  # the tag limit still holds
    assert sum(1 for c in chosen if c.tag != "food") == 70  # and every sight there is room for is in


def test_limits_are_lifted_when_a_city_has_nothing_else():
    cfg = small_config()
    only_food = [cand(i, "restaurant", "food", 5 - i / 100) for i in range(50)]
    assert len(select_city(only_food, 30, cfg)) == 30
    assert len(select_city(only_food[:10], 30, cfg)) == 10


def test_selection_is_best_first_and_stable():
    cfg = small_config()
    candidates = [cand(i, "landmark", "culture", 9 - i / 100) for i in range(20)]
    first = select_city(candidates, 8, cfg)
    assert first == select_city(candidates, 8, cfg)
    assert [c.place_id for c in first] == [f"id{i:04d}" for i in range(8)]


# --- the stage on the fixtures ------------------------------------------------------------------


@pytest.fixture()
def out(staged_out: Path, tmp_path: Path, registry) -> Path:
    """The staged fixtures with the match stage run on them, as in a real run."""
    target = tmp_path / "out"
    shutil.copytree(staged_out, target)
    match(target, FIXTURE_DATE, registry=registry)
    return target


def read(out: Path):
    con = connect()
    cur = con.execute(
        f"SELECT * FROM read_parquet('{curated_file(out, FIXTURE_DATE).as_posix()}') ORDER BY city_code, city_rank"
    )
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r, strict=True)) for r in cur.fetchall()]


def test_curate_ranks_and_selects_the_matched_fixtures(out):
    result = curate(out, FIXTURE_DATE, config=small_config())
    assert result.input == "golden"
    places = read(out)
    assert 0 < len(places) <= 60
    assert {p["city_code"] for p in places} == {"TYO", "OSA"}
    assert len({p["place_id"] for p in places}) == len(places)
    assert all(p["place_id"].startswith("cat-") for p in places)
    # Ranks run 1..n inside each city, best score first.
    for city in ("TYO", "OSA"):
        rows = [p for p in places if p["city_code"] == city]
        assert [p["city_rank"] for p in rows] == list(range(1, len(rows) + 1))
        assert [p["score"] for p in rows] == sorted((p["score"] for p in rows), reverse=True)
    # Provenance: every place keeps its source ids and licences.
    for p in places:
        assert p["sources"] and all(s["source_id"] and s["licence"] and s["raw_ref"] for s in p["sources"])
    assert result.stats["selected_places"] == len(places)


def test_the_same_place_from_two_sources_becomes_one_golden_record(out):
    curate(out, FIXTURE_DATE, config=small_config(total=400, floor=100, cap=300))
    places = read(out)
    merged = [p for p in places if len(p["sources"]) > 1]
    assert merged, "the fixtures have cafes and shrines that two sources list, and matching merges them"
    for p in merged:
        assert len({s["source"] for s in p["sources"]}) == p["n_sources"] >= 2
    # One record for the cafe, not two.
    names = Counter(p["name"] for p in places if p["city_code"] == "TYO")
    assert all(n == 1 for n in names.values() if n)


def test_curate_is_repeatable(out):
    cfg = small_config()
    curate(out, FIXTURE_DATE, config=cfg)
    first = [(p["place_id"], p["score"], p["city_rank"]) for p in read(out)]
    curate(out, FIXTURE_DATE, config=cfg)
    assert first == [(p["place_id"], p["score"], p["city_rank"]) for p in read(out)]


def test_a_small_budget_keeps_the_best_places(out):
    curate(out, FIXTURE_DATE, config=small_config(total=10, floor=2, cap=6))
    places = read(out)
    assert len(places) <= 10
    assert all(sum(1 for q in places if q["city_code"] == c) <= 6 for c in ("TYO", "OSA"))


# --- golden records from the match stage --------------------------------------------------------


MATCHED_SOURCE_TYPE = (
    "STRUCT(source VARCHAR, source_id VARCHAR, licence VARCHAR, raw_ref VARCHAR, "
    "fetched_at TIMESTAMP WITH TIME ZONE, link_rule VARCHAR)"
)


def write_golden(out: Path, records: list[dict]) -> None:
    """A golden.parquet shaped like the match stage's (the columns curate reads, plus a few it ignores)."""
    con = duckdb.connect()
    run(
        con,
        f"""CREATE TABLE g (golden_id VARCHAR, city_code VARCHAR, name VARCHAR, name_en VARCHAR, name_local VARCHAR,
            category VARCHAR, lat DOUBLE, lon DOUBLE, address VARCHAR, website VARCHAR, phone VARCHAR,
            opening_hours VARCHAR, wikidata_qid VARCHAR, description VARCHAR, wikidata_sitelinks INTEGER,
            wikivoyage_listed BOOLEAN, confidence DOUBLE, n_sources INTEGER, sources {MATCHED_SOURCE_TYPE}[])""",
    )
    for r in records:
        con.execute(
            "INSERT INTO g VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, "
            f"CAST(? AS {MATCHED_SOURCE_TYPE}[]))",
            [
                r["golden_id"],
                r["city_code"],
                r["name"],
                r["category"],
                r["lat"],
                r["lon"],
                r.get("website"),
                r.get("qid"),
                r.get("sitelinks"),
                r.get("voyage"),
                r.get("confidence"),
                len(r["sources"]),
                [
                    {
                        "source": s,
                        "source_id": f"{s}-{r['golden_id']}",
                        "licence": "CC0-1.0",
                        "fetched_at": "2026-11-18T00:00:00+00:00",
                        "raw_ref": f"raw/{s}/x.parquet",
                        "link_rule": "x",
                    }
                    for s in r["sources"]
                ],
            ],
        )
    path = golden_file(out, FIXTURE_DATE)
    path.parent.mkdir(parents=True, exist_ok=True)
    run(con, f"COPY g TO '{path.as_posix()}' (FORMAT PARQUET)")


def test_curate_ranks_golden_records(tmp_path):
    out = tmp_path / "out"
    base = {"city_code": "TYO", "lat": 35.68, "lon": 139.76}
    write_golden(
        out,
        [
            {
                **base,
                "golden_id": "g1",
                "name": "Tokyo Tower",
                "category": "landmark",
                "sources": ["overture", "osm", "wikidata"],
                "qid": "Q11264",
                "sitelinks": 120,
                "voyage": True,
                "confidence": 0.9,
            },
            {
                **base,
                "golden_id": "g2",
                "name": "Chain Coffee",
                "category": "cafe",
                "sources": ["overture"],
                "brand": "Q37158",
                "confidence": 0.99,
            },
            {
                **base,
                "golden_id": "g3",
                "name": "Quiet Viewpoint",
                "category": "viewpoint",
                "sources": ["osm"],
            },
            {
                **base,
                "golden_id": "g4",
                "name": "Cheap Diner",
                "category": "restaurant",
                "sources": ["overture"],
                "confidence": 0.7,
            },
            {
                **base,
                "golden_id": "g5",
                "name": "Dubious Place",
                "category": "viewpoint",
                "sources": ["overture"],
                "confidence": 0.2,
            },
        ],
    )
    result = curate(out, FIXTURE_DATE, config=small_config(total=10, floor=1, cap=10))
    assert result.input == "golden"
    places = read(out)
    assert [p["name"] for p in places] == ["Tokyo Tower", "Quiet Viewpoint", "Chain Coffee", "Cheap Diner"]
    assert "Dubious Place" not in {p["name"] for p in places}  # confidence below the minimum
    # A place with a Wikidata QID gets an id built from it, so it stays the same if its sources change.
    tower = places[0]
    assert tower["place_id"] == read_id_for_qid(out)
    assert tower["n_sources"] == 3 and tower["tag"] == "culture"


def read_id_for_qid(out: Path) -> str:
    con = duckdb.connect()
    return con.execute("SELECT 'cat-' || substr(sha256('wikidata:Q11264'), 1, 16)").fetchone()[0]


def test_golden_input_must_match_the_schema(tmp_path):
    out = tmp_path / "out"
    path = golden_file(out, FIXTURE_DATE)
    path.parent.mkdir(parents=True)
    con = duckdb.connect()
    run(con, f"COPY (SELECT 1 AS golden_id) TO '{path.as_posix()}' (FORMAT PARQUET)")
    with pytest.raises(ValueError, match=r"golden.parquet from the match stage"):
        curate(out, FIXTURE_DATE, config=small_config())


def test_a_chain_is_found_through_the_records_behind_a_golden_place(tmp_path):
    """The match output has no brand; a member's staged record carries Overture's brand Wikidata id."""
    from trippr_data.golden import from_matched
    from trippr_data.layout import staged_file

    out = tmp_path / "out"
    base = {"city_code": "TYO", "lat": 35.68, "lon": 139.76}
    write_golden(
        out,
        [{**base, "golden_id": "g2", "name": "Chain Coffee", "category": "cafe", "sources": ["overture"]}],
    )
    members = staged_file(out, FIXTURE_DATE, "overture")
    members.parent.mkdir(parents=True)
    con = duckdb.connect()
    run(
        con,
        f"""COPY (SELECT 'overture' AS source, 'overture-g2' AS source_id,
                   {{'brand_wikidata': 'Q37158'}} AS signals) TO '{members.as_posix()}' (FORMAT PARQUET)""",
    )
    from_matched(con, golden_file(out, FIXTURE_DATE).as_posix(), [members.as_posix()])
    assert con.execute("SELECT signals.brand_wikidata FROM golden").fetchone()[0] == "Q37158"
    from_matched(con, golden_file(out, FIXTURE_DATE).as_posix())
    assert con.execute("SELECT signals.brand_wikidata FROM golden").fetchone()[0] is None


def test_a_pair_the_match_stage_missed_is_folded_into_the_better_place(tmp_path):
    out = tmp_path / "out"
    base = {"city_code": "TYO", "lat": 35.68, "lon": 139.76}
    write_golden(
        out,
        [
            {
                **base,
                "golden_id": "g1",
                "name": "Tianjin Water Park",
                "category": "park_garden",
                "sources": ["wikidata"],
                "sitelinks": 9,
            },
            {
                **base,
                "golden_id": "g2",
                "name": "TIANJIN water park",
                "category": "theme_park",
                "sources": ["overture"],
                "lat": 35.68003,
            },
            {
                **base,
                "golden_id": "g3",
                "name": "Tianjin Water Park",
                "category": "park_garden",
                "sources": ["osm"],
                "lat": 35.7,
            },
        ],
    )
    result = curate(out, FIXTURE_DATE, config=small_config(total=10, floor=1, cap=10))
    places = read(out)
    assert result.stats["merged_duplicates"] == 1
    assert len(places) == 2  # the far one stays: a different place with the same name
    near = next(p for p in places if p["lat"] < 35.69)
    assert {s["source"] for s in near["sources"]} == {"wikidata", "overture"}
    assert near["n_sources"] == 2


def test_curate_needs_the_match_output(staged_out, tmp_path):
    out = tmp_path / "out"
    shutil.copytree(staged_out, out)
    with pytest.raises(FileNotFoundError, match="run the match stage first"):
        curate(out, FIXTURE_DATE, config=small_config())
