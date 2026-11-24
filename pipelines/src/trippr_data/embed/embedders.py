"""Embedding models behind one small interface.

`make_embedder(name)` returns an object with `embed_documents` and `embed_queries` (the E5 family needs
different prefixes for the two, so the split is part of the interface). Vectors are float32, one row
per text, L2-normalised, so cosine similarity is a dot product.

- `fake` (offline tests, no dependencies): a hashed character n-gram bag. Not a language model, but
  deterministic and lexically meaningful, which is enough to test the plumbing and the eval maths.
- ONNX Runtime models (`multilingual-e5-small`, `multilingual-e5-small-q8`): the `embed` extra
  (onnxruntime, tokenizers, huggingface-hub). CPU only, no PyTorch.
- sentence-transformers models (`st-...`): `pip install sentence-transformers` (PyTorch, large). Only the
  spike uses them, for comparison; they are not a project dependency.

Heavy imports happen inside the constructors, so importing this module is cheap and CI never loads a
model. Models download from Hugging Face on first use into the usual HF cache.
"""

from __future__ import annotations

import hashlib
import logging
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

import numpy as np

log = logging.getLogger(__name__)


class Embedder(Protocol):
    name: str  # as recorded in the manifest, e.g. "multilingual-e5-small"
    version: str  # the exact weights, e.g. "intfloat/multilingual-e5-small@c007d7ef"
    dims: int
    doc_prefix: str
    query_prefix: str

    def embed_documents(self, texts: Sequence[str]) -> np.ndarray: ...

    def embed_queries(self, texts: Sequence[str]) -> np.ndarray: ...


def fingerprint(embedder: Embedder) -> str:
    """Identifies what a vector depends on besides its text. Part of the cache key."""
    return f"{embedder.name}|{embedder.version}|{embedder.dims}|{embedder.doc_prefix}"


def l2_normalise(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return (matrix / np.maximum(norms, 1e-12)).astype(np.float32)


# --------------------------------------------------------------------------------------- fake


_TOKEN = re.compile(r"\w+", re.UNICODE)


class FakeEmbedder:
    """Hashed character 1-3-gram counts, log-scaled and normalised. Deterministic across runs and
    platforms (blake2b, not Python's randomised `hash`)."""

    def __init__(self, dims: int = 128, version: str = "1") -> None:
        self.name = f"fake-{dims}"
        self.version = version
        self.dims = dims
        self.doc_prefix = ""
        self.query_prefix = ""
        self.calls: list[int] = []  # batch sizes seen by embed_documents, for tests

    def _vector(self, text: str) -> np.ndarray:
        vec = np.zeros(self.dims, dtype=np.float32)
        for token in _TOKEN.findall(text.casefold()):
            padded = f"^{token}$"
            for n in (1, 2, 3):
                for i in range(len(padded) - n + 1):
                    digest = hashlib.blake2b(padded[i : i + n].encode("utf-8"), digest_size=8).digest()
                    h = int.from_bytes(digest, "little")
                    # Longer grams are more specific, so they count more.
                    vec[h % self.dims] += (1.0 if (h >> 63) & 1 else -1.0) * math.sqrt(n)
        return vec

    def _embed(self, texts: Sequence[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dims), dtype=np.float32)
        return l2_normalise(np.stack([self._vector(t) for t in texts]))

    def embed_documents(self, texts: Sequence[str]) -> np.ndarray:
        self.calls.append(len(texts))
        return self._embed(texts)

    def embed_queries(self, texts: Sequence[str]) -> np.ndarray:
        return self._embed(texts)


# --------------------------------------------------------------------------------- model table


@dataclass(frozen=True)
class ModelSpec:
    name: str
    backend: str  # "onnx" or "st"
    repo: str  # Hugging Face repo with the weights
    dims: int
    doc_prefix: str = ""
    query_prefix: str = ""
    onnx_file: str = "onnx/model.onnx"
    tokenizer_repo: str | None = None  # defaults to repo
    max_length: int = 256  # place texts are short; E5's limit is 512


E5 = {"doc_prefix": "passage: ", "query_prefix": "query: "}

MODELS: dict[str, ModelSpec] = {
    spec.name: spec
    for spec in (
        # The recommendation: E5 small, 384 dims, fp32 ONNX weights from the original repo.
        ModelSpec("multilingual-e5-small", "onnx", "intfloat/multilingual-e5-small", 384, **E5),
        # The same model with 8-bit weights (what transformers.js loads in Node): a quarter of the size.
        ModelSpec(
            "multilingual-e5-small-q8",
            "onnx",
            "Xenova/multilingual-e5-small",
            384,
            onnx_file="onnx/model_quantized.onnx",
            **E5,
        ),
        # Comparison models for the spike (sentence-transformers).
        ModelSpec("st-multilingual-e5-small", "st", "intfloat/multilingual-e5-small", 384, **E5),
        ModelSpec("st-multilingual-e5-base", "st", "intfloat/multilingual-e5-base", 768, **E5),
        ModelSpec(
            "st-paraphrase-multilingual-MiniLM-L12-v2",
            "st",
            "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
            384,
        ),
        ModelSpec("st-bge-m3", "st", "BAAI/bge-m3", 1024),
    )
}


def available_models() -> list[str]:
    return ["fake", *MODELS]


def make_embedder(name: str, *, threads: int | None = None) -> Embedder:
    """`fake`, `fake-<dims>`, or one of MODELS. `threads` caps CPU threads (the spike uses 4, like a
    GitHub runner)."""
    if name == "fake" or name.startswith("fake-"):
        dims = int(name.split("-", 1)[1]) if "-" in name else 128
        return FakeEmbedder(dims=dims)
    spec = MODELS.get(name)
    if spec is None:
        raise ValueError(f"Unknown embedding model {name!r}. Known: {', '.join(available_models())}")
    if spec.backend == "onnx":
        return OnnxEmbedder(spec, threads=threads)
    return SentenceTransformersEmbedder(spec, threads=threads)


# ------------------------------------------------------------------------------------- ONNX


def _revision_of(path: str) -> str:
    """The commit hash from a Hugging Face cache path (.../snapshots/<sha>/...), else 'unknown'."""
    match = re.search(r"snapshots[\\/]([0-9a-f]{40})", path)
    return match.group(1)[:12] if match else "unknown"


class OnnxEmbedder:
    """Mean-pooled sentence embeddings from an ONNX encoder, run with ONNX Runtime on the CPU."""

    def __init__(self, spec: ModelSpec, *, threads: int | None = None, batch_size: int = 32) -> None:
        try:
            import onnxruntime as ort
            from huggingface_hub import hf_hub_download
            from tokenizers import Tokenizer
        except ImportError as err:  # pragma: no cover - depends on the extra
            raise RuntimeError("ONNX embedding needs the 'embed' extra: uv sync --extra embed") from err
        model_path = hf_hub_download(spec.repo, spec.onnx_file)
        tokenizer_path = hf_hub_download(spec.tokenizer_repo or spec.repo, "tokenizer.json")
        options = ort.SessionOptions()
        if threads:
            options.intra_op_num_threads = threads
        self._session = ort.InferenceSession(model_path, options, providers=["CPUExecutionProvider"])
        self._input_names = {i.name for i in self._session.get_inputs()}
        self._tokenizer = Tokenizer.from_file(tokenizer_path)
        self._tokenizer.enable_truncation(max_length=spec.max_length)
        self._tokenizer.enable_padding()
        self._batch_size = batch_size
        self.name = spec.name
        self.version = f"{spec.repo}/{spec.onnx_file}@{_revision_of(model_path)}"
        self.dims = spec.dims
        self.doc_prefix = spec.doc_prefix
        self.query_prefix = spec.query_prefix

    def _embed(self, texts: Sequence[str]) -> np.ndarray:
        out = np.zeros((len(texts), self.dims), dtype=np.float32)
        # Sort by length so each batch pads as little as possible, then restore the order.
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
        for start in range(0, len(order), self._batch_size):
            idx = order[start : start + self._batch_size]
            encodings = self._tokenizer.encode_batch([texts[i] for i in idx])
            ids = np.array([e.ids for e in encodings], dtype=np.int64)
            mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)
            feed = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in self._input_names:
                feed["token_type_ids"] = np.zeros_like(ids)
            hidden = self._session.run(None, feed)[0]
            weights = mask[:, :, None].astype(np.float32)
            pooled = (hidden * weights).sum(axis=1) / np.maximum(weights.sum(axis=1), 1e-9)
            out[idx] = pooled
        return l2_normalise(out)

    def embed_documents(self, texts: Sequence[str]) -> np.ndarray:
        return self._embed([self.doc_prefix + t for t in texts])

    def embed_queries(self, texts: Sequence[str]) -> np.ndarray:
        return self._embed([self.query_prefix + t for t in texts])


# ------------------------------------------------------------------------ sentence-transformers


class SentenceTransformersEmbedder:
    def __init__(self, spec: ModelSpec, *, threads: int | None = None, batch_size: int = 32) -> None:
        try:
            import torch
            from sentence_transformers import SentenceTransformer
        except ImportError as err:  # pragma: no cover - depends on the extra
            raise RuntimeError(
                "sentence-transformers models are for the spike only: pip install sentence-transformers"
            ) from err
        if threads:
            torch.set_num_threads(threads)
        self._model = SentenceTransformer(spec.repo, device="cpu")
        self._model.max_seq_length = spec.max_length
        self._batch_size = batch_size
        self.name = spec.name
        self.version = f"{spec.repo}@sentence-transformers"
        self.dims = spec.dims
        self.doc_prefix = spec.doc_prefix
        self.query_prefix = spec.query_prefix

    def _embed(self, texts: Sequence[str]) -> np.ndarray:
        vectors = self._model.encode(
            list(texts), batch_size=self._batch_size, convert_to_numpy=True, normalize_embeddings=True
        )
        return np.asarray(vectors, dtype=np.float32)

    def embed_documents(self, texts: Sequence[str]) -> np.ndarray:
        return self._embed([self.doc_prefix + t for t in texts])

    def embed_queries(self, texts: Sequence[str]) -> np.ndarray:
        return self._embed([self.query_prefix + t for t in texts])
