"""The ER evaluation tooling on a handful of hand-made records (offline)."""

from __future__ import annotations

import csv

import pytest

from trippr_data.eval_er import evaluate, format_eval, load_labelled, sample_pairs
from trippr_data.layout import eval_file
from trippr_data.match import MatchConfig

from .test_match import DATE, place, write_staged


def records():
    out = []
    for i in range(6):  # six places, each in two sources 20 m apart, plus a different place nearby
        out.append(place("overture", f"o{i}", f"Eval Place {i} Museum", dx=i * 700))
        out.append(place("osm", f"n{i}", f"Eval Place {i} Museum", dx=i * 700 + 20))
        out.append(place("foursquare", f"f{i}", f"Totally Other Name {i}", dx=i * 700 + 30))
    return out


def test_sample_label_and_evaluate_round_trip(tmp_path):
    write_staged(tmp_path, records())
    labels = tmp_path / "pairs.csv"
    n = sample_pairs(tmp_path, DATE, labels, cities=("TYO",), per_city=20)
    assert n > 6
    with open(labels, encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))
    assert {"pair_id", "a_name", "b_name", "distance_m", "label"} <= set(rows[0])
    assert "score" not in rows[0]  # the matcher's score must not anchor the labeller
    # a person's labels: the two Eval Place records are the same place, everything else is not
    for r in rows:
        same = r["a_name"] == r["b_name"]
        r["label"] = "1" if same else "0"
    rows[0]["label"] = "?"  # unsure pairs are left out of the numbers
    with open(labels, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    assert len(load_labelled(labels)) == len(rows) - 1

    result = evaluate(tmp_path, DATE, labels, cfg=MatchConfig(), sweep=(0.6, 0.8, 0.95))
    at = result["at_threshold"]
    assert at["precision"] == 1.0 and at["recall"] >= 0.8
    assert result["pairs_unsure_excluded"] == 1 and "0.80" in result["sweep"]
    assert result["by_city"]["TYO"]["pairs"] == len(rows) - 1
    assert eval_file(tmp_path, DATE).is_file()
    text = format_eval(result)
    assert "precision" in text and "| Threshold |" in text

    # a stricter threshold can only lose recall, never gain precision errors here
    strict = evaluate(tmp_path, DATE, labels, cfg=MatchConfig(threshold=0.99), write=False)
    assert strict["at_threshold"]["recall"] <= at["recall"]

    # sampling again keeps the labels already written
    sample_pairs(tmp_path, DATE, labels, cities=("TYO",), per_city=20)
    with open(labels, encoding="utf-8", newline="") as fh:
        assert sum(1 for r in csv.DictReader(fh) if r["label"] in ("0", "1", "?")) >= len(rows) - 1


def test_evaluate_needs_labels(tmp_path):
    write_staged(tmp_path, records())
    empty = tmp_path / "empty.csv"
    sample_pairs(tmp_path, DATE, empty, cities=("TYO",), per_city=10)
    with pytest.raises(ValueError, match="no labelled pairs"):
        evaluate(tmp_path, DATE, empty)
