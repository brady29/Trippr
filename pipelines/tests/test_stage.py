from pathlib import Path

import duckdb
import pytest

from trippr_data.cities import load_countries
from trippr_data.layout import read_json, stage_stats_file, staged_file
from trippr_data.names import pick_names
from trippr_data.registry import SourceDisabledError, load_registry
from trippr_data.schema import STAGED_COLUMNS, StagedPlace
from trippr_data.stage import stage

from .conftest import FIXTURE_DATE


def staged_rows(out: Path, source: str) -> list[dict]:
    con = duckdb.connect(config={"TimeZone": "UTC"})
    cur = con.execute(f"SELECT * FROM read_parquet('{staged_file(out, FIXTURE_DATE, source).as_posix()}')")
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r, strict=True)) for r in cur.fetchall()]


def raw_rows(source: str, select: str) -> list[dict]:
    from .conftest import FIXTURE_DATA

    con = duckdb.connect(config={"TimeZone": "UTC"})
    glob = (FIXTURE_DATA / "raw" / source / FIXTURE_DATE / "*.parquet").as_posix()
    cur = con.execute(f"SELECT {select} FROM read_parquet('{glob}')")
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r, strict=True)) for r in cur.fetchall()]


ALL_SOURCES = ["overture", "foursquare", "osm", "wikidata", "wikivoyage"]


@pytest.mark.parametrize("source", ALL_SOURCES)
def test_staged_rows_match_the_schema(staged_out, source):
    staged = staged_rows(staged_out, source)
    assert staged
    for row in staged:
        StagedPlace.model_validate(row)
        assert list(row) == list(STAGED_COLUMNS)
        assert row["source"] == source
        assert row["city_code"] in {"TYO", "OSA"}
        assert row["raw_ref"].startswith(f"raw/{source}/{FIXTURE_DATE}/")


def test_overture_fields(staged_out):
    by_id = {r["source_id"]: r for r in staged_rows(staged_out, "overture")}
    raw = {r["id"]: r for r in raw_rows("overture", "*")}
    for sid, row in by_id.items():
        src = raw[sid]
        assert row["lat"] == pytest.approx(src["bbox"]["ymin"])
        assert row["lon"] == pytest.approx(src["bbox"]["xmin"])
        assert row["website"] == (src["websites"] or [None])[0]
        assert row["signals"]["confidence"] == pytest.approx(src["confidence"])
        assert "Overture" not in (row["signals"]["providers"] or [])
        assert row["category_source"] == src["taxonomy"]["primary"]
        licences = {
            s["license"] for s in src["sources"] if s["dataset"] not in ("Overture", "Overture-signals")
        }
        assert set(row["licence"].split(" AND ")) == licences


def test_names_match_the_python_rules(staged_out):
    """The SQL name columns agree with names.pick_names on every staged Overture row."""
    languages = load_countries()["JP"].languages
    raw = {r["id"]: r for r in raw_rows("overture", "id, names")}
    for row in staged_rows(staged_out, "overture"):
        names = raw[row["source_id"]]["names"]
        rules = [(r["language"], r["value"]) for r in names["rules"] or [] if r["variant"] != "short"]
        assert (row["name"], row["name_local"], row["name_en"]) == pick_names(
            names["primary"], rules, languages
        )


def test_english_names_come_from_language_rules(staged_out):
    with_english = [
        r for r in staged_rows(staged_out, "overture") if r["name_en"] and r["name_en"] != r["name"]
    ]
    assert with_english, "fixture should include places with an English name rule"


def test_closed_duplicate_and_wrong_country_rows_are_dropped(staged_out):
    stats = read_json(stage_stats_file(staged_out, FIXTURE_DATE, "foursquare"))
    assert stats["closed"] == 1
    assert stats["duplicate_rows"] == 1
    assert stats["country_mismatch"] == 1
    ids = [r["source_id"] for r in staged_rows(staged_out, "foursquare")]
    assert "fixture-wrong-country" not in ids
    assert len(ids) == len(set(ids))
    ov = read_json(stage_stats_file(staged_out, FIXTURE_DATE, "overture"))
    assert ov["closed"] >= 1


def test_stats_add_up(staged_out):
    for source in ALL_SOURCES:
        s = read_json(stage_stats_file(staged_out, FIXTURE_DATE, source))
        assert s["unique_rows"] == s["raw_rows"] - s["duplicate_rows"]
        assert (
            s["unique_rows"] - s["closed"]
            == s["no_city"] + s["country_mismatch"] + s["other_city"] + s["located"]
        )
        assert s["located"] == (
            s["excluded"] + s["unmapped"] + s["uncategorised"] + s["staged_rows"] + s["no_name"]
        )
        assert sum(c["staged_rows"] for c in s["per_city"].values()) == s["staged_rows"]
        assert 0 <= s["unmapped_share"] <= 1


def test_disabled_source_is_refused(tmp_path, staged_out):
    """When a source is disabled in the registry, staging its raw data is refused."""
    registry = load_registry()
    registry.sources["foursquare"].enabled = False
    with pytest.raises(SourceDisabledError):
        stage(staged_out, FIXTURE_DATE, registry=registry, sources=["foursquare"])


def test_missing_raw_data_is_an_error(tmp_path, registry):
    with pytest.raises(FileNotFoundError):
        stage(tmp_path, FIXTURE_DATE, registry=registry)


def test_osm_fields_come_from_tags(staged_out):
    staged = {r["source_id"]: r for r in staged_rows(staged_out, "osm")}
    raw = {f"{r['osm_type']}/{r['osm_id']}": r for r in raw_rows("osm", "osm_type, osm_id, tags")}
    assert staged and all(sid in raw for sid in staged)
    for sid, row in staged.items():
        tags = dict(raw[sid]["tags"]) if not isinstance(raw[sid]["tags"], dict) else raw[sid]["tags"]
        assert row["name"] == tags["name"] or row["name"].replace(" ", "") == tags["name"].replace(" ", "")
        assert row["licence"] == "ODbL-1.0" and row["opening_hours"] == tags.get("opening_hours")
        assert row["wikidata_qid"] == (
            tags.get("wikidata") if str(tags.get("wikidata", "")).startswith("Q") else None
        )
        assert row["category_source"].split("|")[0].count("=") == 1
    synthetic = [r for r in staged.values() if r["source_id"].startswith("node/9000")]
    assert synthetic and any(r["wikidata_qid"] for r in synthetic)
    with_english = [(row, raw[sid]["tags"]) for sid, row in staged.items() if "name:en" in raw[sid]["tags"]]
    assert with_english
    assert all(row["name_en"] == tags["name:en"] for row, tags in with_english)


def test_wikidata_items_carry_sitelinks_and_a_cc0_description(staged_out):
    staged = staged_rows(staged_out, "wikidata")
    assert staged and all(r["wikidata_qid"] == r["source_id"] for r in staged)
    assert all(r["signals"]["wikidata_sitelinks"] is not None for r in staged)
    described = [r for r in staged if r["signals"]["description"]]
    assert described and all(r["signals"]["description_licence"] == "CC0-1.0" for r in described)
    assert all(r["licence"] == "CC0-1.0" for r in staged)
    assert any(r["name_local"] for r in staged)  # labels in both scripts
    aux = staged_file(staged_out, FIXTURE_DATE, "wikidata").parent / "aux" / "wikidata_qids.parquet"
    assert aux.is_file()  # every fetched item, for sitelink lookups by QID


def test_wikivoyage_listings_are_flagged_and_keep_their_text_licence(staged_out):
    staged = staged_rows(staged_out, "wikivoyage")
    assert staged and all(r["signals"]["wikivoyage_listed"] is True for r in staged)
    assert all(r["licence"] == "CC-BY-SA-4.0" for r in staged)
    texts = [r for r in staged if r["signals"]["description"]]
    assert texts and all(r["signals"]["description_licence"] == "CC-BY-SA-4.0" for r in texts)
    assert {r["category"] for r in staged} <= {"landmark", "tour", "restaurant", "bar", "shopping"}
    stats = read_json(stage_stats_file(staged_out, FIXTURE_DATE, "wikivoyage"))
    assert stats["excluded"] >= 0 and stats["unmapped_share"] == 0
