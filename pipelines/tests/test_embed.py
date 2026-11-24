"""The embed stage and the search eval, offline, with the fake embedder (no model is ever loaded)."""

from __future__ import annotations

import csv
import sys
from pathlib import Path

import numpy as np
import pytest

from trippr_data.cli import main
from trippr_data.embed.embedders import FakeEmbedder, fingerprint, make_embedder
from trippr_data.embed.evaluate import (
    Query,
    evaluate,
    load_queries,
    rank_all,
    resolve_match,
    run_eval_search,
    score_query,
)
from trippr_data.embed.inputs import PlaceRow, read_places
from trippr_data.embed.run import (
    cache_file,
    content_hash,
    embed_places,
    embeddings_dir,
    load_run,
    run_embed,
)
from trippr_data.embed.text import SEPARATOR, build_text, build_texts
from trippr_data.embed.vectors import read_vectors, write_vectors
from trippr_data.layout import read_json, staging_dir

from .conftest import FIXTURE_DATE

EVAL_DIR = Path(__file__).resolve().parents[1] / "eval" / "search"
CATEGORIES = {"temple_shrine": "Temple or shrine", "cafe": "Café, coffee or tea"}
CITIES = {"UKY": "Kyoto"}


def place(pid: str, **fields: str) -> PlaceRow:
    return PlaceRow(place_id=pid, **fields)


# ------------------------------------------------------------------------------- text


def test_text_has_names_category_city_summary_and_description() -> None:
    p = place(
        "a",
        name="清水寺",
        name_en="Kiyomizu-dera",
        category="temple_shrine",
        city="UKY",
        summary="Hillside temple.",
        description="Founded in 778.",
    )
    text = build_text(p, categories=CATEGORIES, cities=CITIES)
    assert text == SEPARATOR.join(
        ["清水寺 / Kiyomizu-dera", "Temple or shrine", "Kyoto", "Hillside temple.", "Founded in 778."]
    )


def test_text_drops_repeated_and_empty_parts() -> None:
    p = place("a", name="Shibuya Sky", name_en="SHIBUYA SKY", name_local="", category="cafe")
    assert build_text(p, categories=CATEGORIES) == "Shibuya Sky · Café, coffee or tea"


def test_text_normalises_width_and_clips_long_descriptions() -> None:
    fullwidth = "ＳＨＩＢＵＹＡ　ｓｋｙ"  # full-width Latin + ideographic space
    p = place("a", name=fullwidth, description="word " * 400)
    text = build_text(p)
    assert text.startswith("SHIBUYA sky · ")
    assert len(text) < 700 and text.endswith("…")


def test_text_falls_back_to_codes_when_no_lookup() -> None:
    assert build_text(place("a", name="X", category="street_food", city="OSA")) == "X · street food · OSA"


def test_build_texts_uses_the_real_taxonomy_and_cities() -> None:
    (text,) = build_texts([place("a", name="X", category="temple_shrine", city="UKY")])
    assert text == "X · Temple or shrine · Kyoto"


# ------------------------------------------------------------------------------ inputs


def test_reads_staged_parquet_with_source_id_pairs(staged_out: Path) -> None:
    places = read_places(str(staging_dir(staged_out, FIXTURE_DATE) / "*.parquet"))
    assert places
    assert all(":" in p.place_id and p.name for p in places)
    assert [p.place_id for p in places] == sorted(p.place_id for p in places)
    assert any(p.category for p in places) and any(p.city for p in places)
    one_city = places[0].city
    only = read_places(str(staging_dir(staged_out, FIXTURE_DATE) / "*.parquet"), city=one_city)
    assert 0 < len(only) <= len(places) and {p.city for p in only} == {one_city}
    assert len(read_places(str(staging_dir(staged_out, FIXTURE_DATE) / "*.parquet"), limit=3)) == 3


def test_reads_csv_with_an_id_column_and_optional_columns_missing(tmp_path: Path) -> None:
    path = tmp_path / "places.csv"
    path.write_text("place_id,name,summary\nb,Second,Nice\na,First,\n", encoding="utf-8")
    places = read_places(path)
    assert [(p.place_id, p.name, p.summary, p.category) for p in places] == [
        ("a", "First", "", ""),
        ("b", "Second", "Nice", ""),
    ]


def test_input_errors_are_clear(tmp_path: Path) -> None:
    no_name = tmp_path / "no_name.csv"
    no_name.write_text("place_id,category\na,cafe\n", encoding="utf-8")
    with pytest.raises(ValueError, match="'name'"):
        read_places(no_name)
    no_id = tmp_path / "no_id.csv"
    no_id.write_text("name\nx\n", encoding="utf-8")
    with pytest.raises(ValueError, match="no id column"):
        read_places(no_id)
    dup = tmp_path / "dup.csv"
    dup.write_text("place_id,name\na,x\na,y\n", encoding="utf-8")
    with pytest.raises(ValueError, match="not unique"):
        read_places(dup)


# ----------------------------------------------------------------------------- embedders


def test_fake_embedder_is_deterministic_normalised_and_prefers_similar_text() -> None:
    e = FakeEmbedder(dims=128)
    a, b, c = e.embed_documents(["Kiyomizu-dera temple", "Kiyomizu temple Kyoto", "Ramen shop Osaka"])
    assert a.dtype == np.float32 and np.isclose(np.linalg.norm(a), 1.0, atol=1e-5)
    assert float(a @ b) > float(a @ c)
    assert np.array_equal(e.embed_documents(["Kiyomizu-dera temple"])[0], a)
    assert e.embed_documents([]).shape == (0, 128)


def test_unknown_model_is_rejected_and_heavy_modules_stay_unloaded() -> None:
    with pytest.raises(ValueError, match="Unknown embedding model"):
        make_embedder("gpt-9")
    assert make_embedder("fake-32").dims == 32
    assert "onnxruntime" not in sys.modules and "sentence_transformers" not in sys.modules


# ------------------------------------------------------------------------------ vectors


def test_vectors_round_trip_through_parquet(tmp_path: Path) -> None:
    matrix = np.random.default_rng(1).standard_normal((5, 7)).astype(np.float32)
    path = tmp_path / "v.parquet"
    write_vectors(path, list("edcba"), [f"h{i}" for i in range(5)], matrix)
    ids, hashes, back = read_vectors(path)
    assert ids == list("abcde")
    assert hashes == ["h4", "h3", "h2", "h1", "h0"]
    assert np.array_equal(back, matrix[::-1])


# ------------------------------------------------------------------------- embed stage


def make_places(n: int = 10) -> list[PlaceRow]:
    return [place(f"p{i:02d}", name=f"Place {i}", category="cafe", city="UKY") for i in range(n)]


def test_embed_writes_vectors_and_a_manifest(tmp_path: Path) -> None:
    places = make_places(10)
    embedder = FakeEmbedder(dims=32)
    result = embed_places(places, build_texts(places), embedder, tmp_path, "2026-01-01", batch_size=4)
    m = result.manifest
    assert (m["model"], m["dims"], m["count"], m["computed"], m["cache_hits"]) == ("fake-32", 32, 10, 10, 0)
    assert m["version"] == "1" and m["text_version"] and m["similarity"] == "cosine" and m["normalized"]
    assert embedder.calls == [4, 4, 2]
    assert read_json(embeddings_dir(tmp_path, "2026-01-01") / "manifest.json") == m
    loaded, ids, matrix = load_run(embeddings_dir(tmp_path, "2026-01-01"))
    assert loaded["count"] == 10 and ids == [p.place_id for p in places] and matrix.shape == (10, 32)
    assert np.allclose(np.linalg.norm(matrix, axis=1), 1.0, atol=1e-5)


def test_second_run_is_served_from_the_cache(tmp_path: Path) -> None:
    places = make_places(10)
    texts = build_texts(places)
    first = FakeEmbedder(dims=32)
    embed_places(places, texts, first, tmp_path, "2026-01-01")
    second = FakeEmbedder(dims=32)
    result = embed_places(places, texts, second, tmp_path, "2026-01-02")
    assert (result.manifest["computed"], result.manifest["cache_hits"]) == (0, 10)
    assert second.calls == []
    _, _, a = load_run(embeddings_dir(tmp_path, "2026-01-01"))
    _, _, b = load_run(embeddings_dir(tmp_path, "2026-01-02"))
    assert np.array_equal(a, b)


def test_only_changed_places_are_recomputed(tmp_path: Path) -> None:
    places = make_places(10)
    embed_places(places, build_texts(places), FakeEmbedder(dims=32), tmp_path, "2026-01-01")
    places[3] = place("p03", name="Renamed", category="cafe", city="UKY")
    again = FakeEmbedder(dims=32)
    result = embed_places(places, build_texts(places), again, tmp_path, "2026-01-02")
    assert (result.manifest["computed"], result.manifest["cache_hits"]) == (1, 9)
    assert again.calls == [1]


def test_a_different_model_or_version_never_reuses_vectors(tmp_path: Path) -> None:
    places = make_places(4)
    texts = build_texts(places)
    embed_places(places, texts, FakeEmbedder(dims=32), tmp_path, "2026-01-01")
    for other in (FakeEmbedder(dims=32, version="2"), FakeEmbedder(dims=48)):
        result = embed_places(places, texts, other, tmp_path, "2026-01-02")
        assert result.manifest["cache_hits"] == 0
    assert content_hash(FakeEmbedder(dims=32), "x") != content_hash(FakeEmbedder(dims=32, version="2"), "x")
    assert fingerprint(FakeEmbedder(dims=32)) != fingerprint(FakeEmbedder(dims=48))


def test_cache_can_be_disabled_and_a_corrupt_cache_is_ignored(tmp_path: Path) -> None:
    places = make_places(4)
    texts = build_texts(places)
    embedder = FakeEmbedder(dims=32)
    embed_places(places, texts, embedder, tmp_path, "2026-01-01")
    assert (
        embed_places(places, texts, embedder, tmp_path, "2026-01-02", use_cache=False).manifest["cache_hits"]
        == 0
    )
    cache_file(tmp_path, embedder).write_bytes(b"not parquet")
    result = embed_places(places, texts, embedder, tmp_path, "2026-01-03")
    assert result.manifest["cache_hits"] == 0 and result.manifest["count"] == 4


def test_duplicate_texts_are_embedded_once(tmp_path: Path) -> None:
    places = [place("a", name="Same"), place("b", name="Same"), place("c", name="Other")]
    embedder = FakeEmbedder(dims=16)
    result = embed_places(places, build_texts(places), embedder, tmp_path, "2026-01-01")
    assert result.manifest["computed"] == 2 and sum(embedder.calls) == 2
    _, _, matrix = load_run(result.directory)
    assert np.array_equal(matrix[0], matrix[1])


def test_a_tampered_vectors_file_fails_the_manifest_check(tmp_path: Path) -> None:
    places = make_places(3)
    result = embed_places(places, build_texts(places), FakeEmbedder(dims=16), tmp_path, "2026-01-01")
    write_vectors(result.vectors_path, ["p00"], ["x"], np.ones((1, 16), dtype=np.float32))
    with pytest.raises(ValueError, match="checksum"):
        load_run(result.directory)


def test_run_embed_reads_staged_places(staged_out: Path, tmp_path: Path) -> None:
    pattern = str(staging_dir(staged_out, FIXTURE_DATE) / "*.parquet")
    result = run_embed(pattern, FakeEmbedder(dims=32), tmp_path, FIXTURE_DATE, limit=20)
    assert result.manifest["count"] == 20 and result.manifest["input"].endswith("*.parquet")
    with pytest.raises(ValueError, match="no places"):
        run_embed(pattern, FakeEmbedder(dims=32), tmp_path, FIXTURE_DATE, city="ZZZ")


# ------------------------------------------------------------------------------- eval


def test_score_query_metrics() -> None:
    ranked = ["x", "a", "y", "b", "z"]
    m = score_query(ranked, frozenset({"a", "b", "c"}))
    assert m["recall@1"] == 0 and m["success@1"] == 0
    assert m["recall@5"] == pytest.approx(2 / 3) and m["success@5"] == 1
    assert m["mrr"] == pytest.approx(0.5)
    ideal = 1 + 1 / np.log2(3) + 1 / np.log2(4)
    assert m["ndcg@10"] == pytest.approx((1 / np.log2(3) + 1 / np.log2(5)) / ideal)
    assert score_query(["a"], frozenset({"a"}))["ndcg@10"] == 1.0
    assert score_query(["x"], frozenset({"a"}))["mrr"] == 0


def test_rank_all_is_brute_force_cosine_with_id_tiebreak() -> None:
    matrix = np.array([[1, 0], [0, 1], [1, 0], [0.8, 0.6]], dtype=np.float32)
    ids = ["d", "b", "a", "c"]
    ranked = rank_all(np.array([[1, 0]], dtype=np.float32), matrix, ids, top=4)
    assert ranked == [["a", "d", "c", "b"]]


def test_match_rules_and_query_files(tmp_path: Path) -> None:
    rows = [
        {"place_id": "1", "city_code": "UKY", "category": "cafe"},
        {"place_id": "2", "city_code": "UKY", "category": "bar"},
        {"place_id": "3", "city_code": "OSA", "category": "cafe"},
    ]
    assert resolve_match({"city_code": "UKY", "category": ["cafe", "bar"]}, rows, "place_id") == {"1", "2"}
    corpus = tmp_path / "places.csv"
    with open(corpus, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=["place_id", "city_code", "category"])
        writer.writeheader()
        writer.writerows(rows)
    queries = tmp_path / "queries.yaml"
    queries.write_text(
        "queries:\n"
        "  - {id: q1, text: cafes, kind: category, match: {city_code: UKY, category: [cafe]}}\n"
        "  - {id: q2, text: x, lang: ja, relevant: ['3']}\n",
        encoding="utf-8",
    )
    loaded = load_queries(queries, corpus)
    assert loaded[0].relevant == frozenset({"1"}) and loaded[0].lang == "en"
    assert loaded[1].relevant == frozenset({"3"}) and loaded[1].lang == "ja"
    queries.write_text("queries:\n  - {id: q1, text: t, match: {city_code: ZZZ}}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="no relevant"):
        load_queries(queries, corpus)


def test_evaluate_rejects_labels_outside_the_corpus() -> None:
    embedder = FakeEmbedder(dims=16)
    vectors = embedder.embed_documents(["alpha", "beta"])
    with pytest.raises(ValueError, match="not in the embeddings"):
        evaluate([Query("q", "alpha", "en", "name", frozenset({"zzz"}))], embedder, ["a", "b"], vectors)


def test_evaluate_finds_an_exact_name_match_first() -> None:
    embedder = FakeEmbedder(dims=64)
    names = ["Kiyomizu-dera", "Fushimi Inari", "Osaka Castle", "Tokyo Tower"]
    vectors = embedder.embed_documents(names)
    queries = [Query("q1", "Osaka Castle", "en", "name", frozenset({"c"}))]
    result = evaluate(queries, embedder, ["a", "b", "c", "d"], vectors)
    assert result["overall"]["mrr"] == 1.0 and result["by_kind"]["name"]["queries"] == 1
    assert result["per_query"][0]["top3"][0] == "c"


# ------------------------------------------------------- the checked-in labelled set


def test_labelled_set_is_consistent() -> None:
    corpus = EVAL_DIR / "places.csv"
    queries = load_queries(EVAL_DIR / "queries.yaml", corpus)
    ids = {p.place_id for p in read_places(corpus)}
    assert len(queries) >= 60
    assert {q.kind for q in queries} == {"name", "category", "intent"}
    assert {"en", "ja", "zh", "ko", "vi", "th"} <= {q.lang for q in queries}
    assert all(q.relevant <= ids for q in queries)


def test_eval_search_end_to_end_with_the_cli(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    corpus = EVAL_DIR / "places.csv"
    out = str(tmp_path)
    assert (
        main(["--out", out, "embed", "--input", str(corpus), "--model", "fake-128", "--date", "2026-02-02"])
        == 0
    )
    manifest = read_json(embeddings_dir(tmp_path, "2026-02-02") / "manifest.json")
    assert manifest["count"] > 2000 and manifest["model"] == "fake-128"
    # A lexical stand-in model: the eval has to run and score above chance, not match a real model.
    assert main(["--out", out, "eval-search", "--min-mrr", "0.2"]) == 0
    report = read_json(tmp_path / "reports" / "2026-02-02.search-eval.json")
    assert report["passed"] and report["overall"]["queries"] >= 60
    assert {"name", "category", "intent"} == set(report["by_kind"])
    assert "recall@10" in capsys.readouterr().out
    assert main(["--out", out, "eval-search", "--min-mrr", "0.99"]) == 1


def test_eval_refuses_embeddings_from_another_model(tmp_path: Path) -> None:
    corpus = EVAL_DIR / "places.csv"
    run_embed(corpus, FakeEmbedder(dims=32), tmp_path, "2026-02-03", limit=50)
    with pytest.raises(ValueError, match="not fake-64"):
        run_eval_search(
            embeddings_dir(tmp_path, "2026-02-03"),
            EVAL_DIR / "queries.yaml",
            corpus,
            FakeEmbedder(dims=64),
            tmp_path,
            "2026-02-03",
        )
