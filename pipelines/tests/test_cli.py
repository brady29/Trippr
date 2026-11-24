"""The match, sample-er and eval-er commands end to end on the staged fixtures (offline)."""

from __future__ import annotations

import csv
import json
import shutil

from trippr_data import cli
from trippr_data.layout import eval_file, golden_file, links_file, match_stats_file

from .conftest import FIXTURE_DATE


def test_match_sample_and_eval_commands(staged_out, tmp_path, capsys):
    out = tmp_path / "out"
    shutil.copytree(staged_out, out)
    assert cli.main(["--out", str(out), "match", "--date", FIXTURE_DATE]) == 0
    assert golden_file(out, FIXTURE_DATE).is_file() and links_file(out, FIXTURE_DATE).is_file()
    stats = json.loads(match_stats_file(out, FIXTURE_DATE).read_text(encoding="utf-8"))
    assert stats["records_in"] > stats["clusters_out"] > 0 and stats["multi_source_clusters"] > 0

    labels = tmp_path / "pairs.csv"
    assert (
        cli.main(
            [
                "--out",
                str(out),
                "sample-er",
                "--date",
                FIXTURE_DATE,
                "--cities",
                "TYO",
                "--per-city",
                "20",
                "--labels",
                str(labels),
            ]
        )
        == 0
    )
    with open(labels, encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))
    assert rows and all(r["label"] == "" for r in rows)
    for r in rows:  # label every pair by whether the two names are the same, as a person would
        r["label"] = "1" if r["a_name"].lower() == r["b_name"].lower() else "0"
    with open(labels, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    assert cli.main(["--out", str(out), "eval-er", "--date", FIXTURE_DATE, "--labels", str(labels)]) == 0
    assert "precision" in capsys.readouterr().out
    assert eval_file(out, FIXTURE_DATE).is_file()
    # a threshold above every score can only lose recall; --strict then reports the unmet targets
    assert cli.main(
        [
            "--out",
            str(out),
            "eval-er",
            "--date",
            FIXTURE_DATE,
            "--labels",
            str(labels),
            "--threshold",
            "0.999",
            "--strict",
        ]
    ) in (0, 1)
