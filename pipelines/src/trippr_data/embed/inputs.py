"""Where the embed stage reads its places from.

Everything that depends on the shape of the input table is in this file. The default input is the
curated bundle's `bundles/<date>/places.parquet` (see bundle.py: `id`, `name`, `name_local`, `name_en`,
`category`, `city_code`, `description`, ...). `FIELD_COLUMNS` maps the fields the embed text uses to the
columns that may hold them, first present column wins, so the enrich stage's `summary` is picked up when
it is added to the table. The staged Parquet files and CSVs (the search eval's corpus) work as they are.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from ..duck import connect, sql_str
from ..layout import bundle_dir, dated_dirs

log = logging.getLogger(__name__)

# Logical field -> candidate columns, in order of preference. A field with no matching column is empty.
FIELD_COLUMNS: dict[str, tuple[str, ...]] = {
    "name": ("name",),
    "name_local": ("name_local",),
    "name_en": ("name_en",),
    "category": ("category",),
    "city": ("city_name", "city_code"),
    "summary": ("summary",),
    "description": ("description", "wikivoyage_text"),
}

# The place id: the first of these columns that exists, else the pairs below joined with ":".
ID_COLUMNS: tuple[str, ...] = ("place_id", "id")
ID_PAIRS: tuple[tuple[str, ...], ...] = (("source", "source_id"),)

REQUIRED_FIELDS = ("name",)


@dataclass(frozen=True)
class PlaceRow:
    """One place as the embed stage sees it. Missing fields are empty strings."""

    place_id: str
    name: str = ""
    name_local: str = ""
    name_en: str = ""
    category: str = ""
    city: str = ""
    summary: str = ""
    description: str = ""


def bundle_places_path(out: Path, date: str) -> Path:
    """Default input: the places of a bundle."""
    return bundle_dir(out, date) / "places.parquet"


def latest_bundle_date(out: Path) -> str | None:
    dates = [d for d in dated_dirs(out / "bundles") if bundle_places_path(out, d).is_file()]
    return dates[-1] if dates else None


def latest_enriched_path(out: Path) -> Path | None:
    """The newest `enriched/<date>/enrichment.parquet` (the enrich stage's output), if any."""
    dates = [
        d for d in dated_dirs(out / "enriched") if (out / "enriched" / d / "enrichment.parquet").is_file()
    ]
    return out / "enriched" / dates[-1] / "enrichment.parquet" if dates else None


def read_summaries(path: str | Path) -> dict[str, str]:
    """place_id -> the AI summary, from the enrich stage's Parquet. Places without one are left out."""
    con = connect()
    try:
        rows = con.execute(
            f"SELECT CAST(place_id AS VARCHAR), trim(summary) FROM read_parquet({sql_str(str(path).replace(chr(92), '/'))}) "
            "WHERE summary IS NOT NULL AND trim(summary) <> ''"
        ).fetchall()
    finally:
        con.close()
    return dict(rows)


def _scan(path: str) -> str:
    lowered = path.lower()
    quoted = sql_str(path)
    if lowered.endswith((".csv", ".tsv")):
        return f"read_csv({quoted}, header=true, all_varchar=true)"
    return f"read_parquet({quoted}, union_by_name=true)"


def read_places(path: str | Path, *, city: str | None = None, limit: int | None = None) -> list[PlaceRow]:
    """Read places for embedding, ordered by id so a run is repeatable.

    `city` keeps one city (matched against the city column the input has); `limit` is for trials.
    """
    source = _scan(str(path).replace("\\", "/"))
    con = connect()
    try:
        columns = {row[0] for row in con.execute(f"DESCRIBE SELECT * FROM {source}").fetchall()}
        id_expr = _id_expression(columns)
        selects = [f"{id_expr} AS place_id"]
        for field, candidates in FIELD_COLUMNS.items():
            present = next((c for c in candidates if c in columns), None)
            if present is None:
                if field in REQUIRED_FIELDS:
                    raise ValueError(f"{path}: none of the columns {list(candidates)} for '{field}'")
                selects.append(f"'' AS {field}")
            else:
                selects.append(f"coalesce(trim(CAST(\"{present}\" AS VARCHAR)), '') AS {field}")
        sql = f"SELECT {', '.join(selects)} FROM {source}"
        params: list[object] = []
        if city:
            city_col = next((c for c in ("city_code", "city_name") if c in columns), None)
            if city_col is None:
                raise ValueError(f"{path}: no city column to filter on")
            sql += f' WHERE "{city_col}" = ?'
            params.append(city)
        sql += " ORDER BY place_id"
        if limit:
            sql += f" LIMIT {int(limit)}"
        fetched = con.execute(sql, params).fetchall()
    finally:
        con.close()
    places = [PlaceRow(*row) for row in fetched]
    ids = [p.place_id for p in places]
    if len(set(ids)) != len(ids):
        raise ValueError(f"{path}: place ids are not unique")
    empty = sum(1 for p in places if not p.name)
    if empty:
        log.warning("%s: %d places have no name and will embed on their other fields", path, empty)
    return places


def _id_expression(columns: set[str]) -> str:
    for column in ID_COLUMNS:
        if column in columns:
            return f'CAST("{column}" AS VARCHAR)'
    for pair in ID_PAIRS:
        if all(c in columns for c in pair):
            return " || ':' || ".join(f'CAST("{c}" AS VARCHAR)' for c in pair)
    raise ValueError(f"no id column: expected one of {list(ID_COLUMNS)} or {[list(p) for p in ID_PAIRS]}")
