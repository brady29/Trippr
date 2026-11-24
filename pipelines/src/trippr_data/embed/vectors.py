"""Vector Parquet files (id, content_hash, vector FLOAT[]) read and written with DuckDB.

Besides the Parquet, a run writes a plain sidecar the Node load job can read without a Parquet library:
`embeddings.f32` (the matrix: row-major little-endian float32, rows in the order of `ids.json`) and
`ids.json` (`{"place_ids": [...], "content_hashes": [...]}`). Both are covered by the run manifest's checksums.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

import numpy as np

from ..duck import connect, sql_str

_CHUNK = 1000  # rows per INSERT: bounds the size of the parameter lists handed to DuckDB


def write_vectors(path: Path, ids: Sequence[str], hashes: Sequence[str], matrix: np.ndarray) -> None:
    """Write rows to a Parquet file, ordered as given. `matrix` is (n, dims) float32."""
    if not (len(ids) == len(hashes) == len(matrix)):
        raise ValueError("ids, hashes and matrix must have the same length")
    dims = matrix.shape[1] if matrix.ndim == 2 else 0
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    con = connect()
    try:
        con.execute(f"CREATE TABLE v (place_id VARCHAR, content_hash VARCHAR, vector FLOAT[{dims or 1}])")
        for start in range(0, len(ids), _CHUNK):
            end = start + _CHUNK
            con.execute(
                f"INSERT INTO v SELECT unnest(?::VARCHAR[]), unnest(?::VARCHAR[]), unnest(?::FLOAT[{dims}][])",
                [list(ids[start:end]), list(hashes[start:end]), matrix[start:end].tolist()],
            )
        con.execute(f"COPY v TO {sql_str(tmp.as_posix())} (FORMAT parquet, COMPRESSION zstd)")
    finally:
        con.close()
    tmp.replace(path)


def read_vectors(path: Path) -> tuple[list[str], list[str], np.ndarray]:
    """(ids, content hashes, (n, dims) float32 matrix) in the file's id order."""
    con = connect()
    try:
        cur = con.execute(
            f"SELECT place_id, content_hash, vector FROM read_parquet({sql_str(path.as_posix())}) "
            "ORDER BY place_id"
        )
        ids, hashes, vectors = [], [], []
        for place_id, content_hash, vector in cur.fetchall():
            ids.append(place_id)
            hashes.append(content_hash)
            vectors.append(vector)
    finally:
        con.close()
    matrix = np.array(vectors, dtype=np.float32) if vectors else np.zeros((0, 0), dtype=np.float32)
    return ids, hashes, matrix


MATRIX_FILE = "embeddings.f32"
IDS_FILE = "ids.json"


def write_sidecar(directory: Path, ids: Sequence[str], hashes: Sequence[str], matrix: np.ndarray) -> None:
    """Write `embeddings.f32` and `ids.json` next to the Parquet, rows in the given order."""
    if not (len(ids) == len(hashes) == len(matrix)):
        raise ValueError("ids, hashes and matrix must have the same length")
    directory.mkdir(parents=True, exist_ok=True)
    # "<f4" is little-endian float32 whatever the machine, so the file reads the same everywhere.
    (directory / MATRIX_FILE).write_bytes(np.ascontiguousarray(matrix, dtype="<f4").tobytes())
    payload = {"place_ids": list(ids), "content_hashes": list(hashes)}
    (directory / IDS_FILE).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def read_sidecar(directory: Path, dims: int) -> tuple[list[str], list[str], np.ndarray]:
    """(ids, content hashes, (n, dims) float32 matrix) in the sidecar's row order."""
    payload = json.loads((directory / IDS_FILE).read_text(encoding="utf-8"))
    raw = np.frombuffer((directory / MATRIX_FILE).read_bytes(), dtype="<f4")
    ids = payload["place_ids"]
    if raw.size != len(ids) * dims:
        raise ValueError(f"{directory / MATRIX_FILE}: {raw.size} floats is not {len(ids)} rows of {dims}")
    return ids, payload["content_hashes"], raw.reshape(len(ids), dims).astype(np.float32)
