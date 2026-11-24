import json
import unicodedata
from pathlib import Path

import duckdb
import pytest

from trippr_data.enrich.inputs import EnrichInput, parse_column_map, read_places

from .conftest import make_place


def write_parquet(path: Path, select_sql: str) -> None:
    duckdb.connect().execute(f"COPY ({select_sql}) TO '{path.as_posix()}' (FORMAT parquet)")


def test_content_hash_ignores_place_id_and_changes_with_any_model_visible_field():
    a = make_place("a", "浅草寺", name_en="Senso-ji")
    b = make_place("b", "浅草寺", name_en="Senso-ji")
    assert a.content_hash() == b.content_hash()
    assert make_place("a", "浅草寺", name_en="Sensoji").content_hash() != a.content_hash()
    assert (
        make_place("a", "浅草寺", name_en="Senso-ji", address="2-3-1 Asakusa").content_hash()
        != a.content_hash()
    )
    with_text = make_place("a", "浅草寺", name_en="Senso-ji", descriptions=[{"source": "osm", "text": "x"}])
    assert with_text.content_hash() != a.content_hash()


def test_content_hash_is_stable_across_unicode_forms_and_description_order():
    composed = "Sensō-ji"
    decomposed = unicodedata.normalize("NFD", composed)
    assert composed != decomposed
    assert make_place("a", composed).content_hash() == make_place("a", decomposed).content_hash()
    d1 = [{"source": "osm", "text": "one"}, {"source": "wikivoyage", "text": "two"}]
    assert (
        make_place("a", "X", descriptions=d1).content_hash()
        == make_place("a", "X", descriptions=list(reversed(d1))).content_hash()
    )


def test_unknown_category_is_rejected():
    with pytest.raises(ValueError, match="not in the taxonomy"):
        make_place("a", "X", category="spaceport")


def test_read_places_from_parquet_with_defaults_and_staged_fallback(tmp_path: Path):
    staged = tmp_path / "staged.parquet"
    write_parquet(
        staged,
        "SELECT 'overture' AS source, 'abc' AS source_id, '浅草寺' AS name, NULL AS name_local, "
        "'Senso-ji' AS name_en, 'temple_shrine' AS category, 'TYO' AS city_code, NULL AS address",
    )
    [place] = read_places(staged)
    assert place.place_id == "overture:abc"
    assert place.name == "浅草寺"
    assert place.name_en == "Senso-ji"
    assert place.descriptions == []


def test_read_places_with_descriptions_struct_and_column_map(tmp_path: Path):
    curated = tmp_path / "curated.parquet"
    write_parquet(
        curated,
        "SELECT 'g1' AS golden_id, 'Wat Pho' AS display_name, 'temple_shrine' AS category, 'BKK' AS city_code, "
        "[{'source': 'wikivoyage', 'text': 'Reclining Buddha.'}] AS descriptions, ['osm', 'wikivoyage'] AS sources",
    )
    mapping = parse_column_map(["place_id=golden_id", "name=display_name"])
    [place] = read_places(curated, mapping)
    assert place.place_id == "g1"
    assert place.name == "Wat Pho"
    assert place.descriptions[0].source == "wikivoyage"
    assert place.sources == ["osm", "wikivoyage"]
    assert place.label_sources() == ["wikivoyage"]


def test_read_places_jsonl(tmp_path: Path):
    path = tmp_path / "p.jsonl"
    path.write_text(
        json.dumps(
            {"place_id": "x", "name": "วัดโพธิ์", "category": "temple_shrine", "city_code": "BKK"},
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    assert read_places(path)[0].name == "วัดโพธิ์"


def test_read_places_reports_every_problem_row(tmp_path: Path):
    path = tmp_path / "p.jsonl"
    rows = [
        {"place_id": "a", "name": "A", "category": "nope", "city_code": "TYO"},
        {"place_id": "b", "name": "", "category": "museum", "city_code": "TYO"},
        {"place_id": "c", "name": "C", "category": "museum", "city_code": "TYO"},
        {"place_id": "c", "name": "C2", "category": "museum", "city_code": "TYO"},
    ]
    path.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    with pytest.raises(ValueError, match=r"3 invalid place\(s\)"):
        read_places(path)


def test_missing_file_and_bad_column_map(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        read_places(tmp_path / "nope.parquet")
    with pytest.raises(ValueError, match="--column-map"):
        parse_column_map(["bogus=thing"])


def test_long_descriptions_are_capped_so_cost_is_bounded():
    place = EnrichInput(
        place_id="a",
        name="X",
        category="museum",
        city_code="TYO",
        descriptions=[{"source": "osm", "text": "y" * 5000}] * 9,
    )
    assert len(place.descriptions) == 4
    assert all(len(d.text) == 1500 for d in place.descriptions)
