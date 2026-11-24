import gzip
import json
import unicodedata
from pathlib import Path

import duckdb
import pytest

from trippr_data.enrich.inputs import (
    EnrichInput,
    clean_description,
    default_input,
    parse_column_map,
    read_places,
)

from .conftest import CURATED_DATE, make_place

GOLDEN_BUNDLE = (
    Path(__file__).parents[1] / "fixtures" / "expected" / "bundle" / "2026-11-18" / "places.jsonl.gz"
)


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
    assert make_place("a", "浅草寺", name_en="Senso-ji", description="x").content_hash() != a.content_hash()
    assert make_place("a", "浅草寺", name_en="Senso-ji", sources=["osm"]).content_hash() != a.content_hash()


def test_content_hash_is_stable_across_unicode_forms_and_source_order():
    composed = "Sensō-ji"
    decomposed = unicodedata.normalize("NFD", composed)
    assert composed != decomposed
    assert make_place("a", composed).content_hash() == make_place("a", decomposed).content_hash()
    assert (
        make_place("a", "X", sources=["osm", "wikivoyage"]).content_hash()
        == make_place("a", "X", sources=["wikivoyage", "osm", "osm"]).content_hash()
    )


def test_unknown_category_is_rejected():
    with pytest.raises(ValueError, match="not in the taxonomy"):
        make_place("a", "X", category="spaceport")


def test_sources_may_be_names_or_records_and_the_label_needs_a_description():
    records = [{"source": "osm", "source_id": "1"}, {"source": "wikivoyage", "source_id": "2"}]
    assert make_place("a", "X", sources=records).sources == ["osm", "wikivoyage"]
    assert make_place("a", "X", sources=records).label_sources() == []  # no description: nothing was read
    assert make_place("a", "X", sources=records, description="Text.").label_sources() == ["osm", "wikivoyage"]


def test_description_markup_and_invisible_characters_are_cleaned_and_capped():
    zero_width = chr(0x200B)
    assert clean_description(f"{zero_width}A stable of  sumo wrestlers.") == "A stable of sumo wrestlers."
    assert clean_description("20px|Must visit! Sculptor Asakura.") == "Must visit! Sculptor Asakura."
    assert len(clean_description("y" * 5000)) == 1500
    assert make_place("a", "X", description="  ").description is None


def test_read_places_from_parquet_with_the_curated_column_names(tmp_path: Path):
    curated = tmp_path / "curated_place.parquet"
    write_parquet(
        curated,
        "SELECT 'cat-abc' AS place_id, 'g1' AS golden_id, '浅草寺' AS name, NULL AS name_local, "
        "'Senso-ji' AS name_en, 'temple_shrine' AS category, 'TYO' AS city_code, NULL AS address, "
        "NULL AS opening_hours, 'Buddhist temple in Asakusa.' AS description, "
        "[{'source': 'overture', 'source_id': 'x'}, {'source': 'wikivoyage', 'source_id': 'y'}] AS sources, "
        "9.5 AS score",
    )
    [place] = read_places(curated)
    assert place.place_id == "cat-abc"
    assert place.name_en == "Senso-ji"
    assert place.description == "Buddhist temple in Asakusa."
    assert place.sources == ["overture", "wikivoyage"]


def test_read_places_from_a_bundle_jsonl_gz_uses_id_as_place_id():
    places = read_places(GOLDEN_BUNDLE)
    assert len(places) == 80
    assert all(p.place_id.startswith("cat-") for p in places)
    assert any(p.description for p in places) and any(not p.description for p in places)
    assert any(len(p.sources) > 1 for p in places)


def test_read_places_staged_fallback_and_column_map(tmp_path: Path):
    staged = tmp_path / "staged.parquet"
    write_parquet(
        staged,
        "SELECT 'overture' AS source, 'abc' AS source_id, 'Wat Pho' AS display_name, "
        "'temple_shrine' AS category, 'BKK' AS city_code",
    )
    [place] = read_places(staged, parse_column_map(["name=display_name"]))
    assert place.place_id == "overture:abc" and place.name == "Wat Pho"


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
    gz = tmp_path / "p.jsonl.gz"
    gz.write_bytes(gzip.compress(path.read_bytes()))
    assert read_places(gz)[0].name == "วัดโพธิ์"


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


def test_the_real_curate_output_is_readable_and_is_the_default_input(curated_out: Path):
    path = default_input(curated_out)
    assert path.name == "curated_place.parquet" and CURATED_DATE in path.as_posix()
    places = read_places(path)
    assert len(places) > 20
    assert len({p.place_id for p in places}) == len(places)
    assert all(p.place_id.startswith("cat-") for p in places)
    assert any(p.description for p in places)
    assert all(isinstance(p, EnrichInput) and p.sources for p in places)


def test_default_input_needs_a_curated_run(tmp_path: Path):
    with pytest.raises(FileNotFoundError, match="run curate first"):
        default_input(tmp_path)
