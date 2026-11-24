"""Entity-resolution unit tests on small hand-made staged records (offline, a few seconds)."""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import pytest

from trippr_data.checks import CheckContext, check_match, open_staged
from trippr_data.cities import load_cities, load_countries
from trippr_data.duck import rows
from trippr_data.layout import golden_file, links_file, staged_file
from trippr_data.match import (
    MatchConfig,
    SpreadGuardedClusters,
    accepted_edges,
    candidate_pairs,
    cluster_edges,
    load_families,
    match,
    open_match_connection,
    prepare_city,
    score_candidates,
    strong_links,
)
from trippr_data.registry import load_registry
from trippr_data.schema import STAGED_COLUMNS
from trippr_data.taxonomy import load_taxonomy

DATE = "2026-11-22"
TOKYO = (35.6586, 139.7454)  # Tokyo Tower, inside the TYO radius
LAT_PER_METRE = 1 / 111_320
LON_PER_METRE = 1 / (111_320 * 0.8135)  # cos(35.66 degrees)


def place(source, source_id, name, *, dx=0.0, dy=0.0, **kw):
    """A staged record `dx` metres east and `dy` metres north of Tokyo Tower."""
    signals = {
        "description": None,
        "description_licence": None,
        "wikipedia_url": None,
        "wikidata_sitelinks": None,
        "wikivoyage_listed": None,
        "confidence": None,
        "providers": None,
        "brand_wikidata": None,
    }
    signals.update(kw.pop("signals", {}))
    licence = {
        "osm": "ODbL-1.0",
        "wikidata": "CC0-1.0",
        "wikivoyage": "CC-BY-SA-4.0",
        "foursquare": "Apache-2.0",
    }.get(source, "CDLA-Permissive-2.0")
    record = {
        "source": source,
        "source_id": source_id,
        "name": name,
        "name_local": None,
        "name_en": None,
        "category_source": "x",
        "category": "museum",
        "lat": TOKYO[0] + dy * LAT_PER_METRE,
        "lon": TOKYO[1] + dx * LON_PER_METRE,
        "city_code": "TYO",
        "address": None,
        "website": None,
        "phone": None,
        "opening_hours": None,
        "wikidata_qid": None,
        "signals": signals,
        "licence": licence,
        "fetched_at": "2026-11-22T00:00:00+00:00",
        "raw_ref": f"raw/{source}/{DATE}/TYO.parquet",
    }
    record.update(kw)
    return record


def write_staged(out: Path, records: list[dict]) -> None:
    by_source: dict[str, list[dict]] = {}
    for r in records:
        by_source.setdefault(r["source"], []).append(r)
    con = duckdb.connect()
    columns = "{" + ", ".join(f"{c}: '{t}'" for c, t in STAGED_COLUMNS.items()) + "}"
    for source, recs in by_source.items():
        target = staged_file(out, DATE, source)
        target.parent.mkdir(parents=True, exist_ok=True)
        nd = target.with_suffix(".ndjson")
        nd.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in recs) + "\n", encoding="utf-8")
        con.execute(
            f"COPY (SELECT * FROM read_json('{nd.as_posix()}', format = 'newline_delimited', columns = {columns})) "
            f"TO '{target.as_posix()}' (FORMAT parquet)"
        )
        nd.unlink()


def matcher(tmp_path: Path, records: list[dict], cfg: MatchConfig | None = None):
    """A connection with the city prepared, candidates generated and scored."""
    write_staged(tmp_path, records)
    sources = sorted({r["source"] for r in records})
    con = open_match_connection(tmp_path, DATE, sources)
    load_families(con)
    cfg = cfg or MatchConfig()
    prepare_city(con, "TYO", cfg)
    candidate_pairs(con, cfg)
    score_candidates(con, cfg)
    strong_links(con, cfg)
    return con, cfg


class PairTable(dict):
    """Scored pairs keyed by (record, record) in either order."""

    def __getitem__(self, key):
        return super().__getitem__(key) if super().__contains__(key) else super().__getitem__(key[::-1])

    def __contains__(self, key):
        return super().__contains__(key) or super().__contains__(key[::-1])


def pairs(con) -> PairTable:
    return PairTable({(r["ra"], r["rb"]): r for r in rows(con, "SELECT * FROM scored")})


# Blocking ---------------------------------------------------------------------------------------


def test_blocking_pairs_nearby_compatible_records_of_different_sources(tmp_path):
    con, _ = matcher(
        tmp_path,
        [
            place("overture", "a", "Tokyo Museum"),
            place("osm", "b", "Tokyo Museum", dx=40),
            place("foursquare", "far", "Tokyo Museum", dx=900),  # outside 500 m
            place("osm", "c", "Tokyo Shrine", dx=40, category="temple_shrine"),  # museum vs shrine
            place("overture", "same", "Tokyo Museum", dx=30),  # same source as a
        ],
    )
    found = pairs(con)
    assert ("overture:a", "osm:b") in found
    assert not any("far" in a + b for a, b in found)
    assert not any("osm:c" in (a, b) for a, b in found)  # incompatible category families
    assert ("overture:a", "overture:same") not in found


def test_blocking_stays_inside_a_city(tmp_path):
    other = place("osm", "elsewhere", "Tokyo Museum", dx=10, city_code="OSA")
    con, _ = matcher(tmp_path, [place("overture", "a", "Tokyo Museum"), other])
    assert pairs(con) == {}


def test_broad_categories_are_compatible_with_many_families(tmp_path):
    con, _ = matcher(
        tmp_path,
        [
            place("wikivoyage", "w", "Tokyo Tower", category="landmark"),
            place("osm", "o", "Tokyo Tower", dx=20, category="viewpoint"),
            place("overture", "m", "Tokyo Tower", dx=20, category="museum"),
        ],
    )
    found = pairs(con)
    assert ("osm:o", "wikivoyage:w") in found and ("overture:m", "wikivoyage:w") in found


# Strong links -----------------------------------------------------------------------------------


def strong(con):
    return {frozenset((r["ra"], r["rb"])): r["rule"] for r in rows(con, "SELECT ra, rb, rule FROM strong")}


def test_a_shared_wikidata_qid_is_a_strong_link_even_with_different_names(tmp_path):
    con, _ = matcher(
        tmp_path,
        [
            place("osm", "a", "Tokyo Tower", wikidata_qid="Q11615"),
            place("wikidata", "Q11615", "東京タワー", dx=120, wikidata_qid="Q11615"),
        ],
    )
    assert strong(con) == {frozenset(("osm:a", "wikidata:Q11615")): "strong_qid"}


def test_a_qid_used_by_many_places_of_one_source_is_a_brand_not_an_identity(tmp_path):
    chain = [place("osm", f"c{i}", "Chain Cafe", dx=i * 50, wikidata_qid="Q1") for i in range(5)]
    con, _ = matcher(tmp_path, [*chain, place("wikidata", "Q1", "Chain", wikidata_qid="Q1")])
    assert strong(con) == {}


def test_a_shared_website_within_300_m_is_a_strong_link(tmp_path):
    con, _ = matcher(
        tmp_path,
        [
            place("overture", "a", "Teien Museum", website="https://www.teien.example/en/"),
            place("foursquare", "b", "Garden Art Museum", dx=200, website="http://teien.example"),
            place(
                "osm", "c", "Garden Art Museum", dx=-400, website="https://teien.example/"
            ),  # 400 m from a, 600 m from b
        ],
    )
    assert strong(con) == {frozenset(("overture:a", "foursquare:b")): "strong_website"}


def test_shared_hosts_only_link_the_same_page(tmp_path):
    con, _ = matcher(
        tmp_path,
        [
            place("overture", "a", "Shop One", website="https://facebook.com/shopone"),
            place("foursquare", "b", "Shop One", dx=20, website="https://www.facebook.com/shopone/"),
            place("osm", "c", "Shop Two", dx=20, website="https://facebook.com/shoptwo"),
        ],
    )
    assert strong(con) == {frozenset(("overture:a", "foursquare:b")): "strong_website"}


# Scoring ----------------------------------------------------------------------------------------


def test_same_name_close_by_scores_above_the_threshold_and_a_different_name_does_not(tmp_path):
    con, cfg = matcher(
        tmp_path,
        [
            place("overture", "a", "Shibuya Sky"),
            place("osm", "b", "SHIBUYA SKY", dx=30),
            place("foursquare", "c", "Hachiko Statue", dx=30, category="monument"),
        ],
    )
    scored = pairs(con)
    same = scored[("overture:a", "osm:b")]
    assert same["name_sim"] == 1.0 and same["dist_score"] == 1.0 and same["score"] >= cfg.threshold
    other = scored.get(("foursquare:c", "overture:a"))
    assert other is None or other["name_sim"] < cfg.name_floor


def test_distance_score_is_full_under_75_m_and_falls_linearly_to_zero_at_500_m(tmp_path):
    con, _ = matcher(
        tmp_path,
        [
            place("overture", "a", "Same Name"),
            place("osm", "b", "Same Name", dy=60),
            place("foursquare", "c", "Same Name", dy=120),
        ],
    )
    scored = pairs(con)
    assert scored[("overture:a", "osm:b")]["dist_score"] == pytest.approx(1.0)
    # (500 - 120) / (500 - 75): the pair is generated at any distance up to 500 m inside the blocking cells
    assert scored[("overture:a", "foursquare:c")]["dist_score"] == pytest.approx(0.894, abs=0.01)


def test_cjk_and_romanised_variants_are_compared_across_name_fields(tmp_path):
    """A has a Japanese name and an English one; B has only the English one in a different case, and C
    only the Japanese one with a suffix. Both match A through the variant they share."""
    con, cfg = matcher(
        tmp_path,
        [
            place(
                "overture",
                "a",
                "渋谷スカイ",
                name_local="渋谷スカイ",
                name_en="Shibuya Sky",
                category="viewpoint",
            ),
            place("osm", "b", "SHIBUYA SKY", dx=35, name_en="SHIBUYA SKY", category="viewpoint"),
            place(
                "wikivoyage",
                "c",
                "渋谷スカイ展望台",
                dx=35,
                name_local="渋谷スカイ展望台",
                category="viewpoint",
            ),
        ],
    )
    scored = pairs(con)
    ab = scored[("overture:a", "osm:b")]
    ac = scored[("overture:a", "wikivoyage:c")]
    assert ab["name_sim"] == 1.0 and ab["score"] >= cfg.threshold
    assert 0.6 < ac["name_sim"] < 1.0 and ac["score"] >= cfg.threshold


def test_names_in_different_scripts_with_no_shared_variant_do_not_match(tmp_path):
    con, cfg = matcher(
        tmp_path,
        [
            place("overture", "a", "浅草寺", name_local="浅草寺"),
            place("osm", "b", "Sensoji", dx=10, name_en="Sensoji"),
        ],
    )
    scored = next(iter(pairs(con).values()))
    assert scored["name_sim"] == 0.0 and scored["score"] < cfg.threshold


def test_a_matching_phone_adds_a_bonus_and_an_address_does_too(tmp_path):
    con, _ = matcher(
        tmp_path,
        [
            place("overture", "a", "Ramen Ichi", category="restaurant", phone="+81 3-1234-5678"),
            place("foursquare", "b", "Ramen Ichi", dx=100, category="restaurant", phone="03-1234-5678"),
            place("osm", "c", "Ramen Ichi", dx=100, category="restaurant", address="1-2-3 Roppongi, Minato"),
            place(
                "wikivoyage",
                "d",
                "Ramen Ichi",
                dx=100,
                category="restaurant",
                address="1-2-3 ROPPONGI MINATO",
            ),
        ],
    )
    scored = pairs(con)
    assert scored[("foursquare:b", "overture:a")]["phone_match"]
    assert scored[("osm:c", "wikivoyage:d")]["addr_match"]
    assert scored[("foursquare:b", "overture:a")]["score"] > scored[("overture:a", "osm:c")]["score"]


# Accepted pairs and clustering ------------------------------------------------------------------


def test_only_the_best_partner_per_source_is_kept_when_there_is_no_tie_margin(tmp_path):
    """Two OSM places near one Overture place: the better match links, the other is left alone."""
    con, cfg = matcher(
        tmp_path,
        [
            place("overture", "a", "Hanazono Shrine", category="temple_shrine"),
            place("osm", "good", "Hanazono Shrine", dx=20, category="temple_shrine"),
            place("osm", "close", "Hanazono Gift Shop", dx=10, category="temple_shrine"),
        ],
        MatchConfig(tie_margin=0.0),
    )
    edges = {frozenset((a, b)) for a, b, *_ in accepted_edges(con, cfg)}
    assert frozenset(("overture:a", "osm:good")) in edges
    assert not any("osm:close" in e for e in edges)


def test_near_duplicates_in_one_source_both_link_to_the_other_sources_record(tmp_path):
    """Foursquare often lists a place twice; both listings are the same place as the Overture one."""
    con, cfg = matcher(
        tmp_path,
        [
            place("overture", "a", "Domino Pizza Suyeong", category="restaurant"),
            place("foursquare", "f1", "Domino Pizza Suyeong", dx=5, category="restaurant"),
            place("foursquare", "f2", "Dominos Pizza Suyeong", dx=8, category="restaurant"),
        ],
    )
    edges = {frozenset((a, b)) for a, b, *_ in accepted_edges(con, cfg)}
    assert frozenset(("overture:a", "foursquare:f1")) in edges
    assert frozenset(("overture:a", "foursquare:f2")) in edges


def test_chain_names_need_to_be_much_closer(tmp_path):
    """A chain name 120 m apart is probably two branches; a unique name 150 m apart can be one place."""
    chain = [place("overture", f"k{i}", "KFC", dx=1500 + 700 * i, category="restaurant") for i in range(4)]
    con, cfg = matcher(
        tmp_path,
        [
            *chain,
            place("overture", "k", "KFC", category="restaurant"),
            place("foursquare", "kf", "KFC", dx=120, category="restaurant"),
            place("overture", "u", "Unique Garden", dy=2000, category="park_garden"),
            place("foursquare", "uf", "Unique Garden", dy=2000 + 150, category="park_garden"),
        ],
    )
    scored = pairs(con)
    assert scored[("overture:k", "foursquare:kf")]["dist_score"] == pytest.approx(0.25, abs=0.02)
    assert scored[("overture:u", "foursquare:uf")]["dist_score"] > 0.7


def test_a_shared_website_needs_some_name_similarity(tmp_path):
    con, _ = matcher(
        tmp_path,
        [
            place("foursquare", "spa", "Le Spa du Metropole", website="https://hotel.example/"),
            place("overture", "restaurant", "Angelina Italian Lounge", dx=50, website="https://hotel.example/"),
            place("osm", "same", "Le Spa Metropole", dx=60, website="https://hotel.example/"),
        ],
    )
    found = strong(con)
    assert frozenset(("foursquare:spa", "osm:same")) in found
    assert frozenset(("foursquare:spa", "overture:restaurant")) not in found


def test_the_spread_guard_refuses_a_merge_that_would_make_a_wide_cluster():
    coords = {
        "a": (35.0, 139.0),
        "b": (35.0, 139.0 + 300 * LON_PER_METRE),
        "c": (35.0, 139.0 + 600 * LON_PER_METRE),
    }
    guard = SpreadGuardedClusters(coords, max_spread_m=500)
    assert guard.union("a", "b") and guard.union("b", "c") is False  # a-c would be 600 m
    assert guard.find("a") == guard.find("b") != guard.find("c")
    assert guard.refused == 1


def test_clusters_take_strong_links_first_and_report_the_best_score():
    coords = {r: (35.0, 139.0) for r in "abc"}
    edges = [("a", "b", 0.9, "scored", 10.0), ("b", "c", 1.0, "strong_qid", 10.0)]
    assigned, counters = cluster_edges("TYO", edges, coords, MatchConfig())
    assert len({cid for cid, _, _ in assigned.values()}) == 1
    assert assigned["b"][1:] == (1.0, "strong_qid") and assigned["a"][1:] == (0.9, "scored")
    assert counters == {"edges": 2, "merged": 2, "refused_by_spread": 0}


# End to end: survivorship, links, golden and checks -----------------------------------------------


def one_place_in_five_sources():
    return [
        place(
            "overture",
            "o1",
            "Hanazono Shrine",
            name_en="Hanazono Shrine",
            category="temple_shrine",
            dx=30,
            website="https://hanazono.example/",
            phone="+81 3-1111-2222",
            address="5-17-3 Shinjuku",
        ),
        place(
            "osm",
            "node/1",
            "花園神社",
            name_local="花園神社",
            category="temple_shrine",
            dx=0,
            opening_hours="24/7",
            wikidata_qid="Q5645123",
            website="https://osm-site.example/",
        ),
        place("foursquare", "f1", "Hanazono Jinja", category="temple_shrine", dx=45, phone="03-1111-2222"),
        place(
            "wikidata",
            "Q5645123",
            "Hanazono Shrine",
            name_en="Hanazono Shrine",
            name_local="花園神社",
            category="temple_shrine",
            dx=10,
            wikidata_qid="Q5645123",
            signals={
                "wikidata_sitelinks": 7,
                "description": "Shinto shrine in Tokyo",
                "description_licence": "CC0-1.0",
            },
        ),
        place(
            "wikivoyage",
            "w1",
            "Hanazono Shrine",
            name_en="Hanazono Shrine",
            category="landmark",
            dx=20,
            signals={
                "wikivoyage_listed": True,
                "description": "A quiet shrine.",
                "description_licence": "CC-BY-SA-4.0",
            },
        ),
        place("overture", "lonely", "Unrelated Cafe", category="cafe", dx=2000),
    ]


def test_match_writes_links_and_golden_with_field_level_survivorship(tmp_path):
    write_staged(tmp_path, one_place_in_five_sources())
    stats = match(tmp_path, DATE, registry=load_registry())
    assert stats["records_in"] == 6 and stats["clusters_out"] == 2 and stats["multi_source_clusters"] == 1
    assert stats["links_by_rule"]["strong_qid"] == 2  # osm and wikidata share the QID

    con = duckdb.connect()
    golden = rows(
        con, f"SELECT * FROM read_parquet('{golden_file(tmp_path, DATE).as_posix()}') ORDER BY n_records DESC"
    )
    top = golden[0]
    assert top["n_records"] == 5 and top["n_sources"] == 5 and golden[1]["n_records"] == 1
    assert top["name"] == "Hanazono Shrine"  # names: Wikidata first
    assert top["name_local"] == "花園神社"
    assert top["description"] == "A quiet shrine." and top["description_licence"] == "CC-BY-SA-4.0"
    assert top["description_source"] == "wikivoyage"
    assert top["opening_hours"] == "24/7"  # OSM
    assert top["website"] == "https://hanazono.example/"  # Overture before OSM
    assert top["category"] == "temple_shrine"  # not the generic "landmark" from Wikivoyage
    assert top["wikidata_qid"] == "Q5645123" and top["wikidata_sitelinks"] == 7 and top["wikivoyage_listed"]
    assert top["field_sources"]["coordinates"] == "osm" and top["field_sources"]["name"] == "wikidata"
    assert top["lat"] == pytest.approx(TOKYO[0]) and top["lon"] == pytest.approx(TOKYO[1])  # the OSM point
    assert set(top["licences"]) == {
        "CC-BY-SA-4.0",
        "CC0-1.0",
        "ODbL-1.0",
        "Apache-2.0",
        "CDLA-Permissive-2.0",
    }
    assert sorted(s["source"] for s in top["sources"]) == [
        "foursquare",
        "osm",
        "overture",
        "wikidata",
        "wikivoyage",
    ]
    assert all(s["licence"] and s["raw_ref"] for s in top["sources"])

    links = rows(con, f"SELECT * FROM read_parquet('{links_file(tmp_path, DATE).as_posix()}')")
    assert len(links) == 6 and {r["cluster_id"] for r in links} == {g["golden_id"] for g in golden}
    assert next(r for r in links if r["source_id"] == "lonely")["rule"] == "singleton"


def test_match_checks_pass_and_catch_broken_links(tmp_path):
    write_staged(tmp_path, one_place_in_five_sources())
    match(tmp_path, DATE, registry=load_registry())
    ctx = CheckContext(
        registry=load_registry(),
        cities={c.code: c for c in load_cities()},
        countries=load_countries(),
        taxonomy=set(load_taxonomy()),
    )
    con = open_staged(
        [staged_file(tmp_path, DATE, s) for s in ("foursquare", "osm", "overture", "wikidata", "wikivoyage")]
    )
    from trippr_data.duck import connect  # noqa: F401  (hav_km is defined by connect)

    statuses = {r.name: r.status for r in check_match(con, ctx, tmp_path, DATE)}
    assert statuses == {
        "match.cluster_spread": "pass",
        "match.links": "pass",
        "match.golden_licences": "pass",
        "match.duplicate_golden": "pass",
        "match.eval": "info",
    }
    # a link to a record that does not exist, and a golden record without licences, are failures
    broken = tmp_path / "broken"
    broken.mkdir()
    duckdb.connect().execute(
        f"COPY (SELECT * REPLACE ('osm:ghost' AS record_id, 'ghost' AS source_id) FROM read_parquet('{links_file(tmp_path, DATE).as_posix()}') LIMIT 1) "
        f"TO '{(broken / 'links.parquet').as_posix()}' (FORMAT parquet)"
    )
    out2 = tmp_path / "out2"
    (out2 / "matched" / DATE).mkdir(parents=True)
    (broken / "links.parquet").replace(out2 / "matched" / DATE / "links.parquet")
    duckdb.connect().execute(
        f"COPY (SELECT * REPLACE ([]::VARCHAR[] AS licences) FROM read_parquet('{golden_file(tmp_path, DATE).as_posix()}')) "
        f"TO '{(out2 / 'matched' / DATE / 'golden.parquet').as_posix()}' (FORMAT parquet)"
    )
    failed = {r.name for r in check_match(con, ctx, out2, DATE) if r.status == "fail"}
    assert {"match.links", "match.golden_licences"} <= failed
