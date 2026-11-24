"""The embed command's default input is the newest curated bundle's places.parquet."""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from trippr_data.cli import main
from trippr_data.embed.run import embeddings_dir
from trippr_data.layout import read_json


def write_bundle(root: Path, date: str, rows: int) -> None:
    folder = root / "bundles" / date
    folder.mkdir(parents=True)
    target = (folder / "places.parquet").as_posix()
    con = duckdb.connect()
    con.execute(
        "COPY (SELECT 'g:' || i AS id, 'Place ' || i AS name, NULL::VARCHAR AS name_local, "
        "'cafe' AS category, 'UKY' AS city_code, 'A cafe.' AS description "
        f"FROM range({rows}) t(i)) TO '{target}' (FORMAT parquet)"
    )
    con.close()


def test_embed_defaults_to_the_newest_bundle(tmp_path: Path) -> None:
    write_bundle(tmp_path, "2026-03-01", 3)
    write_bundle(tmp_path, "2026-03-05", 4)
    assert main(["--out", str(tmp_path), "embed", "--model", "fake-32"]) == 0
    manifest = read_json(embeddings_dir(tmp_path, "2026-03-05") / "manifest.json")
    assert manifest["count"] == 4
    assert manifest["input"].endswith("bundles/2026-03-05/places.parquet")


def test_embed_without_a_bundle_says_so(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="No bundle"):
        main(["--out", str(tmp_path), "embed", "--model", "fake-32"])
