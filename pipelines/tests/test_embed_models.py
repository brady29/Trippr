"""Model table and label-rule details that need no model download."""

from __future__ import annotations

from trippr_data.embed.embedders import MODELS, available_models
from trippr_data.embed.evaluate import resolve_match

ROWS = [
    {
        "place_id": "1",
        "city_code": "OSA",
        "description": "A giant Panda lives here",
        "category": "aquarium_zoo",
    },
    {"place_id": "2", "city_code": "OSA", "description": None, "category": "aquarium_zoo"},
    {"place_id": "3", "city_code": "TYO", "description": "Zen garden", "category": "park_garden"},
]


def test_model_table_is_consistent() -> None:
    assert "fake" in available_models()
    for name, spec in MODELS.items():
        assert spec.name == name
        assert spec.backend in {"onnx", "st"}
        assert spec.pooling in {"mean", "cls"}
        assert spec.dims > 0 and spec.max_length > 0
        if spec.backend == "onnx":
            assert spec.onnx_file.endswith(".onnx")
    # E5 needs its query/passage prefixes; BGE-M3 needs none and pools the CLS token.
    assert MODELS["multilingual-e5-small"].query_prefix == "query: "
    assert MODELS["bge-m3"].query_prefix == "" and MODELS["bge-m3"].pooling == "cls"
    assert MODELS["bge-m3"].dims == 1024 and MODELS["multilingual-e5-small"].dims == 384


def test_regex_rules_search_the_column_and_skip_empty_ones() -> None:
    assert resolve_match({"description~": "panda"}, ROWS, "place_id") == {"1"}
    assert resolve_match({"description~": "panda|zen"}, ROWS, "place_id") == {"1", "3"}
    assert resolve_match({"city_code": "OSA", "description~": "panda"}, ROWS, "place_id") == {"1"}
    assert resolve_match({"city_code": "TYO", "description~": "panda"}, ROWS, "place_id") == set()
