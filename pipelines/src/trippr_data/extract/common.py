"""Shared extract helpers: one Parquet file per city plus a _meta.json per source and date."""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import duckdb

from ..cities import City
from ..duck import run, scalar
from ..layout import raw_dir, read_json, write_json
from ..registry import SourceEntry
from ..settings import utc_now

log = logging.getLogger(__name__)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bbox_filter(city: City, lon_col: str, lat_col: str) -> str:
    min_lon, min_lat, max_lon, max_lat = city.bbox
    return f"{lon_col} BETWEEN {min_lon} AND {max_lon} AND {lat_col} BETWEEN {min_lat} AND {max_lat}"


@dataclass
class ExtractRun:
    source: str
    entry: SourceEntry
    out: Path
    date: str
    version: str
    dataset_path: str
    query_template: str
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def directory(self) -> Path:
        return raw_dir(self.out, self.source, self.date)

    def write_city(self, con: duckdb.DuckDBPyConnection, city: City, select_sql: str) -> dict[str, Any]:
        """Run one city's bounding-box query and write the rows exactly as received."""
        self.directory.mkdir(parents=True, exist_ok=True)
        target = self.directory / f"{city.code}.parquet"
        tmp = target.with_suffix(".parquet.tmp")
        started = time.monotonic()
        run(con, f"COPY ({select_sql}) TO '{tmp.as_posix()}' (FORMAT parquet, COMPRESSION zstd)")
        tmp.replace(target)
        rows = scalar(con, f"SELECT count(*) FROM read_parquet('{target.as_posix()}')")
        info = {
            "city": city.code,
            "country": city.country,
            "radius_km": city.radius_km,
            "bbox": list(city.bbox),
            "rows": int(rows),
            "bytes": target.stat().st_size,
            "sha256": sha256_file(target),
            "fetched_at": utc_now().isoformat(),
            "seconds": round(time.monotonic() - started, 1),
        }
        log.info("%s %s: %s rows in %.1fs", self.source, city.code, f"{rows:,}", info["seconds"])
        return info

    def write_meta(self, files: dict[str, dict[str, Any]]) -> dict[str, Any]:
        """Merge with an existing _meta.json so cities extracted in separate calls share one manifest."""
        meta_path = self.directory / "_meta.json"
        existing = read_json(meta_path) if meta_path.is_file() else {}
        if existing and existing.get("version") != self.version:
            log.warning("replacing %s extracted from version %s", meta_path, existing.get("version"))
            existing = {}
        merged_files = {**existing.get("files", {}), **files}
        meta = {
            "source": self.source,
            "source_name": self.entry.name,
            "licence": self.entry.licence,
            "attribution": self.entry.attribution.strip(),
            "terms_checked_on": self.entry.terms_checked_on.isoformat(),
            "version": self.version,
            "dataset_path": self.dataset_path,
            "query_template": self.query_template,
            "run_date": self.date,
            "fetched_at": max(f["fetched_at"] for f in merged_files.values()),
            "row_count": sum(f["rows"] for f in merged_files.values()),
            **self.extra,
            "files": dict(sorted(merged_files.items())),
        }
        write_json(meta_path, meta)
        return meta
