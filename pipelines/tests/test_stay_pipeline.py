"""Stay stages on the fixtures: hotels, Inside Airbnb staging, aggregates, scores, checks and report."""

from __future__ import annotations

import json
import shutil
import statistics
from pathlib import Path

import duckdb
import pytest

from trippr_data.cities import haversine_km
from trippr_data.layout import read_json
from trippr_data.stay import checks as stay_checks
from trippr_data.stay.airbnb import parse_price
from trippr_data.stay.config import load_stay_config
from trippr_data.stay.geo import geometry_area_km2, neighbourhood_areas
from trippr_data.stay.hotels import cluster_pairs, osm_pre_rows, osm_stars
from trippr_data.stay.layout import stay_stats_file, stay_table
from trippr_data.stay.report import stay_section
from trippr_data.stay.scoring import centrality_score

from .conftest import FIXTURE_DATE, STAY_FIXTURES

CFG = load_stay_config()


def table(out: Path, name: str, where: str = "true", cols: str = "*") -> list[dict]:
    con = duckdb.connect()
    cur = con.execute(
        f"SELECT {cols} FROM read_parquet('{stay_table(out, FIXTURE_DATE, name).as_posix()}') WHERE {where}"
    )
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r, strict=True)) for r in cur.fetchall()]


# --- hotels ------------------------------------------------------------------------------------------


def test_hotels_are_merged_across_and_within_sources(stay_out):
    stats = read_json(stay_stats_file(stay_out, FIXTURE_DATE, "hotel"))
    assert stats["hotels"] == 21
    assert stats["merge"]["records"] == 28
    tokyu = table(stay_out, "hotel", "name LIKE 'Tokyu Stay%'")[0]
    # Foursquare, OSM and two Overture records (one a same-source duplicate 12 m away) are one hotel.
    assert tokyu["n_sources"] == 4
    assert [s.split(":")[0] for s in tokyu["sources"]] == [
        "foursquare",
        "osm_lodging",
        "overture",
        "overture",
    ]
    assert tokyu["stars"] == 3 and tokyu["wikidata_qid"] == "Q111"
    assert tokyu["website"] == "https://www.tokyustay.example/shibuya"  # OSM first in the precedence
    assert tokyu["kind"] == "hotel"
    assert tokyu["area_id"] == "area-tyo-shibuya"
    assert tokyu["area_dist_km"] == pytest.approx(0.65, abs=0.02)
    assert set(tokyu["licences"]) == {"CDLA-Permissive-2.0", "Apache-2.0", "ODbL-1.0"}


def test_hotel_drops_and_kinds(stay_out):
    stats = read_json(stay_stats_file(stay_out, FIXTURE_DATE, "hotel"))
    fsq, osm, ov = (stats["sources"][s] for s in ("foursquare", "osm_lodging", "overture"))
    assert fsq["closed"] == 1 and ov["closed"] == 1  # closed places never become hotels
    assert osm["no_name"] == 1 and osm["no_city"] == 1  # unnamed; a hotel outside every city
    assert (
        fsq["excluded_kind"] == 1 and osm["excluded_kind"] == 1 and ov["excluded_kind"] == 1
    )  # campsites, chalet
    names = {h["name"] for h in table(stay_out, "hotel")}
    assert not names & {
        "Fixture Campground",
        "Fixture Chalet",
        "Closed Fixture Inn",
        "Too Far Hotel",
        "Fixture Ramen",
    }
    kinds = {h["name"]: h["kind"] for h in table(stay_out, "hotel")}
    assert kinds["Asakusa Fixture Ryokan"] == "inn"
    assert kinds["Fixture Lodging"] == "other"
    assert kinds["Shinjuku Fixture Apartments"] == "apartment"
    assert stats["by_kind"]["other"] == 1


def test_cjk_and_english_names_of_one_hotel_are_kept_apart(stay_out):
    guest = table(stay_out, "hotel", "name_en = 'Asakusa Guest House'")[0]
    assert guest["name"] == "浅草ゲストハウス" and guest["name_local"] == "浅草ゲストハウス"
    assert guest["n_sources"] == 2  # two OSM nodes 5 m apart with the same name


def test_hotel_source_rows_keep_provenance(stay_out):
    rows = table(stay_out, "hotel_source", "source = 'osm_lodging'")
    assert {r["raw_ref"] for r in rows} == {
        "raw/osm_lodging/2026-11-18/TYO.json",
        "raw/osm_lodging/2026-11-18/OSA.json",
    }
    assert all(r["licence"] == "ODbL-1.0" for r in rows)
    assert {r["hotel_id"] for r in rows} <= {h["hotel_id"] for h in table(stay_out, "hotel")}


def test_osm_tag_parsing():
    assert [osm_stars(x) for x in ("3", "4S", " 5", "0", "", None, "x")] == [3, 4, 5, None, None, None, None]
    rows = osm_pre_rows(
        [
            {
                "type": "way",
                "id": 1,
                "center": {"lat": 1.0, "lon": 2.0},
                "tags": {"tourism": "hotel", "name": "A", "name:en": "A en", "name:zh-Hans": "x"},
            },
            {"type": "node", "id": 2, "lat": 1.0, "lon": 2.0, "tags": {"name": "no tourism tag"}},
            {"type": "node", "id": 3, "tags": {"tourism": "hotel"}},
        ],
        "f.json",
    )
    assert len(rows) == 1
    assert rows[0]["source_id"] == "way/1" and rows[0]["lat"] == 1.0
    assert rows[0]["names_by_lang"] == [{"language": "en", "value": "A en"}]  # regional variants skipped


def test_cluster_guard_refuses_a_chain_wider_than_the_limit():
    coords = {1: (35.0, 139.0), 2: (35.0008, 139.0), 3: (35.0016, 139.0)}  # about 89 m apart each
    pairs = [(1, 2, 0.09, 0.99), (2, 3, 0.09, 0.98)]
    assert cluster_pairs(pairs, coords, 0.2) == {1: 1, 2: 1, 3: 1}
    # 178 m end to end is over a 150 m limit: the second merge is skipped.
    assert cluster_pairs(pairs, coords, 0.15) == {1: 1, 2: 1, 3: 3}


# --- Inside Airbnb staging ----------------------------------------------------------------------------


def test_price_parsing():
    assert parse_price("$1,338.49") == 1338.49
    assert parse_price("$12,500.00") == 12500.0
    assert parse_price("") is None and parse_price(None) is None and parse_price("n/a") is None


def test_listings_are_cleaned_and_converted(stay_out):
    stats = read_json(stay_stats_file(stay_out, FIXTURE_DATE, "airbnb"))
    tyo, sin = stats["per_city"]["TYO"], stats["per_city"]["SIN"]
    assert (tyo["listings"], sin["listings"]) == (117, 28)
    assert tyo["currency"] == "JPY" and tyo["snapshot"] == "2026-09-25"
    assert tyo["cad_per_unit"] == pytest.approx(0.00901) and tyo["rate_date"] == "2026-09-25"
    assert (tyo["price_missing"], tyo["below_floor"], tyo["above_p99"]) == (3, 1, 1)
    assert tyo["long_stay"] == 4 and tyo["other_room_type"] == 1
    assert sin["other_room_type"] == 1  # "Something new" in the fixture; reported, not dropped
    assert tyo["in_radius"] == 115  # two listings on a far island are outside Tokyo's 25 km
    row = table(stay_out, "airbnb_listing", "price_status = 'ok' AND listing_id = 1013")[0]
    assert row["price_cad"] == pytest.approx(row["price_local"] * 0.00901, abs=0.006)
    assert row["fx_cad_per_unit"] == 0.00901  # not truncated by the first city's column type
    assert row["price_per_person_cad"] == pytest.approx(
        row["price_cad"] / max(row["accommodates"], 1), abs=0.01
    )


def test_price_status_and_stats_flags(stay_out):
    by_status = {
        r["price_status"]: r["n"]
        for r in table(
            stay_out, "airbnb_listing", "city_code = 'TYO' GROUP BY 1", "price_status, count(*) AS n"
        )
    }
    assert by_status == {"ok": 112, "missing": 3, "below_floor": 1, "above_p99": 1}
    # Long stays are priced but not used for price statistics.
    long_stay = table(stay_out, "airbnb_listing", "NOT short_stay AND price_status = 'ok'")
    assert long_stay and not any(r["stats_ok"] for r in long_stay)
    assert all(r["price_cad"] >= CFG.price.floor_cad for r in table(stay_out, "airbnb_listing", "stats_ok"))


def test_room_types_are_normalised(stay_out):
    kinds = {r["room_type"] for r in table(stay_out, "airbnb_listing")}
    assert kinds <= {"entire_home", "private_room", "shared_room", "hotel_room", "other"}
    assert "other" in kinds


def test_calendar_and_reviews_summaries(stay_out):
    cal = table(stay_out, "airbnb_calendar", "city_code = 'TYO'")
    assert len(cal) == 117 and {c["days"] for c in cal} == {40}
    assert all(
        0 <= c["unavailable_days"] <= 40
        and c["unavailable_30"] <= c["unavailable_90"] <= c["unavailable_days"]
        for c in cal
    )
    listings = table(stay_out, "airbnb_listing")
    assert all(
        r["reviews_ltm"] == (r["reviews_12m_summary"] or 0) for r in listings
    )  # fixture reviews are built to agree
    monthly = table(stay_out, "airbnb_reviews_monthly", "city_code = 'SIN'")
    assert sum(m["reviews"] for m in monthly) == sum(
        r["number_of_reviews"] for r in table(stay_out, "airbnb_listing", "city_code = 'SIN'")
    )


def test_neighbourhood_area_from_the_polygon():
    areas = neighbourhood_areas(STAY_FIXTURES / "raw/insideairbnb/2026-11-18/SIN/neighbourhoods.geojson")
    # a 0.01 x 0.01 degree rectangle at 1.3 N is about 1.2395 km2 x cos(1.3 deg)
    assert areas["Kallang"] == pytest.approx(111.32 * 0.01 * 111.32 * 0.01 * 0.9997, rel=0.01)
    hole = {
        "type": "Polygon",
        "coordinates": [
            [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1], [0, 0]],
            [[0.02, 0.02], [0.04, 0.02], [0.04, 0.04], [0.02, 0.04], [0.02, 0.02]],
        ],
    }
    assert geometry_area_km2(hole) == pytest.approx(
        geometry_area_km2({"type": "Polygon", "coordinates": [hole["coordinates"][0]]}) * (1 - 0.04), rel=0.01
    )
    assert geometry_area_km2({"type": "Point", "coordinates": [0, 0]}) == 0.0


# --- aggregates and scores ---------------------------------------------------------------------------


def unit(out: Path, kind: str, unit_id: str) -> dict:
    return table(out, "stay_unit", f"unit_kind = '{kind}' AND unit_id = '{unit_id}'")[0]


def test_unit_kinds_and_counts(stay_out):
    summary = read_json(stay_stats_file(stay_out, FIXTURE_DATE, "airbnb"))  # stats exist
    assert summary
    kinds = {
        r["unit_kind"]: r["n"]
        for r in table(stay_out, "stay_unit", "true GROUP BY 1", "unit_kind, count(*) AS n")
    }
    assert kinds["city"] == 2 and kinds["neighbourhood"] == 7 and kinds["area"] == 19
    assert all(
        u["n_listings"] >= CFG.privacy.min_listings for u in table(stay_out, "stay_unit", "unit_kind = 'h3'")
    )


def test_area_aggregates_match_an_independent_computation(stay_out):
    area = unit(stay_out, "area", "area-tyo-shibuya")
    listings = table(stay_out, "airbnb_listing", "city_code = 'TYO' AND geo_ok")
    inside = [r for r in listings if haversine_km(r["lat"], r["lon"], 35.659, 139.7) <= 1.5]
    assert area["n_listings"] == len(inside) == 40
    used = [r for r in inside if r["stats_ok"]]
    assert area["n_priced"] == len(used)
    assert area["median_price_cad"] == pytest.approx(
        statistics.median(r["price_cad"] for r in used), abs=0.01
    )
    assert area["median_price_pp_cad"] == pytest.approx(
        statistics.median(r["price_per_person_cad"] for r in used), abs=0.01
    )
    entire = [r["price_cad"] for r in used if r["room_type"] == "entire_home"]
    assert area["median_price_entire_cad"] == pytest.approx(statistics.median(entire), abs=0.01)
    assert area["entire_home_share"] == pytest.approx(
        sum(r["room_type"] == "entire_home" for r in inside) / len(inside), abs=1e-4
    )
    rated = [r["rating"] for r in inside if r["rating"] is not None]
    assert area["n_rated"] == len(rated) and area["median_rating"] == pytest.approx(
        statistics.median(rated), abs=0.001
    )
    assert area["n_reviewed10"] == sum(r["number_of_reviews"] >= 10 for r in inside)
    assert area["reviews_ltm"] == sum(r["reviews_ltm"] for r in inside)
    assert area["listing_density_km2"] == pytest.approx(40 / (3.141592653589793 * 1.5**2), abs=0.01)
    assert area["n_hotels"] == 2  # Tokyu Stay and the Shibuya hostel


def test_host_concentration_and_availability(stay_out):
    city = unit(stay_out, "city", "TYO")
    in_radius = table(stay_out, "airbnb_listing", "city_code = 'TYO' AND in_radius")
    multi = [r for r in in_radius if r["host_listings"] >= CFG.hosts.multi_listing_min]
    assert city["multi_host_share"] == pytest.approx(len(multi) / len(in_radius), abs=1e-4)
    assert 0 < city["top_hosts_share"] < 1
    cal = {c["listing_id"]: c for c in table(stay_out, "airbnb_calendar", "city_code = 'TYO'")}
    days = sum(cal[r["listing_id"]]["days"] for r in in_radius)
    blocked = sum(cal[r["listing_id"]]["unavailable_days"] for r in in_radius)
    assert city["unavailable_share"] == pytest.approx(blocked / days, abs=1e-4)


def test_coordinates_and_distances_are_rounded_so_platforms_agree(stay_out):
    """H3 cell centres differ in the last digits between h3 builds; the published tables carry 6 decimals."""
    for u in table(stay_out, "stay_unit"):
        for key, digits in (("lat", 6), ("lon", 6), ("centre_km", 3), ("station_km", 3), ("area_km2", 3)):
            if u[key] is not None:
                assert u[key] == round(u[key], digits), (u["unit_id"], key, u[key])
    cells = table(stay_out, "stay_unit", "unit_kind = 'h3'")
    assert cells and all(len(repr(c["lat"]).split(".")[1]) <= 6 for c in cells)


def test_privacy_minimum_empties_small_units(stay_out):
    island = unit(stay_out, "neighbourhood", "TYO/Ogasawara Mura")
    assert island["n_listings"] == 2
    assert (
        island["median_price_cad"] is None
        and island["median_rating"] is None
        and island["multi_host_share"] is None
    )
    assert island["n_places"] is None  # centred far outside Tokyo's radius: no place data, not "zero places"
    assert island["stay_score"] is None


def test_scores_follow_the_formula(stay_out):
    asakusa, shibuya = unit(stay_out, "area", "area-tyo-asakusa"), unit(stay_out, "area", "area-tyo-shibuya")
    for u in (asakusa, shibuya):
        assert u["score_parts"] == ["value", "reviews", "centrality", "walkability", "quiet"]
        expected = sum(w * u[f"score_{k}"] for k, w in CFG.weights.model_dump().items())
        assert u["stay_score"] == pytest.approx(expected, abs=0.15)  # parts are rounded to 0.1
        assert u["weight_coverage"] == 1.0
        assert u["explanation"].startswith("Cheaper than")
    for u in (asakusa, shibuya):  # the centrality part is the documented formula of the unit's distances
        assert u["score_centrality"] == pytest.approx(
            centrality_score(u["centre_km"], u["station_km"], CFG.centrality), abs=0.06
        )
        assert f"{u['centre_km']:.1f} km from the city centre" in u["explanation"]
    # Shibuya is busier (more places, more bars) and dearer; Asakusa is quieter and cheaper.
    assert shibuya["score_walkability"] > asakusa["score_walkability"]
    assert asakusa["score_quiet"] > shibuya["score_quiet"] and asakusa["score_quiet"] == 100.0
    assert asakusa["score_value"] > shibuya["score_value"]
    assert asakusa["cheaper_than_share"] == pytest.approx(asakusa["score_value"] / 100, abs=0.001)
    assert (asakusa["n_places"], asakusa["n_nightlife"]) == (12, 0)
    assert shibuya["n_places"] == 70


def test_a_city_with_no_places_gets_only_listing_parts(stay_out):
    kallang = unit(stay_out, "neighbourhood", "SIN/Kallang")
    assert kallang["n_places"] is None and kallang["score_walkability"] is None
    assert kallang["score_value"] is None  # 7 priced listings, under the minimum of 10
    assert kallang["score_reviews"] is not None
    assert kallang["stay_score"] is None and kallang["score_parts"] == [
        "centrality",
        "reviews",
    ]  # 40% of the weight is not enough


def test_areas_without_data_are_listed_unscored(stay_out):
    bangkok_like = unit(stay_out, "area", "area-bjs-gulou")
    assert bangkok_like["n_listings"] == 0 and bangkok_like["stay_score"] is None


def test_summary_headlines(stay_out):
    from trippr_data.stay.layout import stay_summary_file

    summary = read_json(stay_summary_file(stay_out, FIXTURE_DATE))
    assert summary["coverage"]["inside_airbnb_cities"] == ["SIN", "TYO"]
    assert summary["coverage"]["no_inside_airbnb"] == 106
    assert summary["cities"]["TYO"]["areas"] == 3
    assert (
        summary["cities"]["TYO"]["top_neighbourhoods"][0]["stay_score"]
        >= summary["cities"]["TYO"]["top_neighbourhoods"][-1]["stay_score"]
    )


# --- checks ------------------------------------------------------------------------------------------


def run_checks(out, registry, **kw):
    return stay_checks.check(out, FIXTURE_DATE, registry=registry, baseline=None, **kw)


def test_checks_pass_on_the_fixtures(stay_out, registry):
    passed, results = run_checks(stay_out, registry)
    failed = [r for r in results if r.status == "fail"]
    assert passed, failed
    by_name = {r.name: r.status for r in results}
    assert by_name["stay.airbnb.room_types"] == "warn"  # the fixture's unknown room type is reported
    assert by_name["stay.airbnb.checksums"] == "pass" and by_name["stay.unit.privacy"] == "pass"


def copy_out(stay_out: Path, tmp_path: Path) -> Path:
    out = tmp_path / "out"
    shutil.copytree(stay_out, out)
    return out


def test_a_changed_raw_file_fails_the_checksum_check(stay_out, registry, tmp_path):
    out = copy_out(stay_out, tmp_path)
    with open(out / "raw/insideairbnb" / FIXTURE_DATE / "TYO" / "reviews.csv", "a", encoding="utf-8") as fh:
        fh.write("1,2020-01-01\n")
    passed, results = run_checks(out, registry)
    assert not passed
    assert next(r for r in results if r.name == "stay.airbnb.checksums").status == "fail"


def test_missing_prices_fail_the_coverage_check(stay_out, registry, tmp_path):
    out = copy_out(stay_out, tmp_path)
    path = stay_stats_file(out, FIXTURE_DATE, "airbnb")
    stats = read_json(path)
    stats["per_city"]["SIN"]["price_missing"] = 20
    path.write_text(json.dumps(stats), encoding="utf-8")
    passed, results = run_checks(out, registry, verify_raw=False)
    assert not passed
    assert next(r for r in results if r.name == "stay.airbnb.price_coverage").status == "fail"


def test_duplicate_nearby_hotels_fail(stay_out, registry, tmp_path):
    out = copy_out(stay_out, tmp_path)
    hotel = stay_table(out, FIXTURE_DATE, "hotel")
    con = duckdb.connect()
    con.execute(
        f"""COPY (SELECT * FROM read_parquet('{hotel.as_posix()}')
                  UNION ALL SELECT * REPLACE ('h_dup' AS hotel_id, lat + 0.0001 AS lat)
                  FROM read_parquet('{hotel.as_posix()}') WHERE name LIKE 'Tokyu%')
               TO '{hotel.with_suffix(".new").as_posix()}' (FORMAT parquet)"""
    ).fetchall()
    hotel.with_suffix(".new").replace(hotel)
    passed, results = run_checks(out, registry, verify_raw=False)
    assert not passed
    assert next(r for r in results if r.name == "stay.hotel.duplicates").status == "fail"


def test_counts_are_compared_with_the_previous_run():
    current = {"hotel": {"TYO": 1000, "OSA": 10}, "airbnb_listing": {"TYO": 500}}
    base = {
        "run_date": "2026-10-01",
        "counts": {"hotel": {"TYO": 1000, "OSA": 40}, "airbnb_listing": {"TYO": 1000}},
    }
    results = {r.name: r for r in stay_checks.check_counts(current, base)}
    assert results["stay.counts.vs_previous"].status == "fail"  # Airbnb halved
    assert results["stay.counts.small_cities"].status == "warn"  # a small city moved a lot
    assert stay_checks.check_counts(current, None)[0].status == "info"


# --- report ------------------------------------------------------------------------------------------


def test_report_section(stay_out, registry):
    passed, _ = run_checks(stay_out, registry)
    assert passed
    text = "\n".join(stay_section(stay_out, FIXTURE_DATE, registry))
    assert (
        "## Stay analytics" in text
        and "Inside Airbnb has data for 2 of Trippr's 108 cities (SIN, TYO)" in text
    )
    assert "| TYO | 2026-09-25 | JPY |" in text
    assert "21 hotels after merging 28 source records" in text
    assert "Data from Inside Airbnb (insideairbnb.com), CC BY 4.0" in text
    assert "© OpenStreetMap contributors" in text
    assert stay_section(stay_out.parent, "1999-01-01", registry) == []
