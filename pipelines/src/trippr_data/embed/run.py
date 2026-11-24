"""The embed stage: curated places in, a Parquet of vectors and a manifest out.

    out/embeddings/<date>/embeddings.parquet   place_id, content_hash, vector
    out/embeddings/<date>/manifest.json        model, version, dims, text version, counts, checksums
    out/cache/embeddings/<model>.parquet       content_hash -> vector, kept between runs

A vector is keyed by the hash of the model fingerprint and the exact text, so a place whose text did
not change is never embedded again (the same idea as the enrich stage's cache), and switching model or
template recomputes everything. The cache keeps every vector it has seen (a run limited to one city
must not forget the others); delete the file to start clean.
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..layout import read_json, write_json
from ..settings import utc_now
from .embedders import Embedder, fingerprint
from .inputs import PlaceRow, read_places
from .text import TEXT_VERSION, build_texts
from .vectors import read_vectors, write_vectors

log = logging.getLogger(__name__)

DEFAULT_BATCH_SIZE = 64
VECTORS_FILE = "embeddings.parquet"
MANIFEST_FILE = "manifest.json"


def embeddings_dir(out: Path, date: str) -> Path:
    return out / "embeddings" / date


def latest_embeddings_date(out: Path) -> str | None:
    from ..layout import dated_dirs

    dates = dated_dirs(out / "embeddings")
    return dates[-1] if dates else None


def cache_file(out: Path, embedder: Embedder) -> Path:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", embedder.name)
    return out / "cache" / "embeddings" / f"{slug}.parquet"


def content_hash(embedder: Embedder, text: str) -> str:
    """sha256 of what a vector depends on: the model fingerprint, the text version and the text."""
    payload = f"{fingerprint(embedder)}\n{TEXT_VERSION}\n{text}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass
class EmbedResult:
    directory: Path
    manifest: dict[str, Any]

    @property
    def vectors_path(self) -> Path:
        return self.directory / VECTORS_FILE


def _load_cache(path: Path, dims: int) -> dict[str, np.ndarray]:
    if not path.is_file():
        return {}
    try:
        _, hashes, matrix = read_vectors(path)
    except Exception as err:  # a corrupt cache costs a recompute, never a failed run
        log.warning("ignoring unreadable embedding cache %s: %s", path, err)
        return {}
    if matrix.size == 0 or matrix.shape[1] != dims:
        return {}
    return dict(zip(hashes, matrix, strict=True))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def embed_places(
    places: list[PlaceRow],
    texts: list[str],
    embedder: Embedder,
    out: Path,
    date: str,
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
    use_cache: bool = True,
    input_label: str = "",
) -> EmbedResult:
    """Embed `texts` (one per place), reusing cached vectors, and write the run's files."""
    if len(places) != len(texts):
        raise ValueError("places and texts must have the same length")
    started = time.monotonic()
    hashes = [content_hash(embedder, t) for t in texts]
    cache_path = cache_file(out, embedder)
    cached = _load_cache(cache_path, embedder.dims) if use_cache else {}

    # Embed each distinct uncached text once, in batches.
    todo: dict[str, str] = {}
    for h, text in zip(hashes, texts, strict=True):
        if h not in cached and h not in todo:
            todo[h] = text
    fresh: dict[str, np.ndarray] = {}
    todo_hashes = list(todo)
    for start in range(0, len(todo_hashes), batch_size):
        batch = todo_hashes[start : start + batch_size]
        vectors = np.asarray(embedder.embed_documents([todo[h] for h in batch]), dtype=np.float32)
        if vectors.shape != (len(batch), embedder.dims):
            raise ValueError(
                f"{embedder.name} returned {vectors.shape}, expected {(len(batch), embedder.dims)}"
            )
        fresh.update(zip(batch, vectors, strict=True))
        log.info("embedded %d/%d", min(start + batch_size, len(todo_hashes)), len(todo_hashes))
    hits = sum(1 for h in hashes if h in cached)

    lookup = {**cached, **fresh}
    matrix = np.stack([lookup[h] for h in hashes]) if hashes else np.zeros((0, embedder.dims), np.float32)
    ids = [p.place_id for p in places]

    directory = embeddings_dir(out, date)
    vectors_path = directory / VECTORS_FILE
    write_vectors(vectors_path, ids, hashes, matrix)
    if use_cache:
        keys = list(lookup)
        write_vectors(cache_path, keys, keys, np.stack([lookup[h] for h in keys]) if keys else matrix)

    manifest: dict[str, Any] = {
        "stage": "embed",
        "model": embedder.name,
        "version": embedder.version,
        "dims": embedder.dims,
        "normalized": True,
        "similarity": "cosine",
        "doc_prefix": embedder.doc_prefix,
        "query_prefix": embedder.query_prefix,
        "text_version": TEXT_VERSION,
        "count": len(ids),
        "computed": len(todo),
        "cache_hits": hits,
        "input": input_label,
        "vectors_file": VECTORS_FILE,
        "vectors_sha256": _sha256(vectors_path),
        "created_at": utc_now().isoformat(),
        "seconds": round(time.monotonic() - started, 2),
    }
    write_json(directory / MANIFEST_FILE, manifest)
    log.info(
        "embed: %d places, %d vectors computed, %d from cache (%s, %d dims)",
        len(ids),
        len(todo),
        hits,
        embedder.name,
        embedder.dims,
    )
    return EmbedResult(directory=directory, manifest=manifest)


def run_embed(
    input_path: str | Path,
    embedder: Embedder,
    out: Path,
    date: str,
    *,
    city: str | None = None,
    limit: int | None = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
    use_cache: bool = True,
) -> EmbedResult:
    places = read_places(input_path, city=city, limit=limit)
    if not places:
        raise ValueError(f"{input_path}: no places to embed")
    return embed_places(
        places,
        build_texts(places),
        embedder,
        out,
        date,
        batch_size=batch_size,
        use_cache=use_cache,
        input_label=str(input_path).replace("\\", "/"),
    )


def load_run(directory: Path) -> tuple[dict[str, Any], list[str], np.ndarray]:
    """(manifest, ids, matrix) of a finished embed run; checks the file against the manifest."""
    manifest = read_json(directory / MANIFEST_FILE)
    path = directory / manifest["vectors_file"]
    if _sha256(path) != manifest["vectors_sha256"]:
        raise ValueError(f"{path} does not match its manifest checksum")
    ids, _, matrix = read_vectors(path)
    if matrix.shape != (manifest["count"], manifest["dims"]):
        raise ValueError(f"{path}: shape {matrix.shape} does not match the manifest")
    return manifest, ids, matrix
