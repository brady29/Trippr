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


@pytest.mark.parametrize("source", ["overture", "foursquare"])
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
    for source in ("overture", "foursquare"):
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
