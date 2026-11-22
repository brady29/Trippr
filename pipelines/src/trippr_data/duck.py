"""DuckDB connection helpers."""

from __future__ import annotations

from typing import Any

import duckdb

from .cities import EARTH_RADIUS_KM
from .names import is_latin, normalize_name


def connect(*, remote: bool = False, s3_region: str | None = None) -> duckdb.DuckDBPyConnection:
    """An in-memory DuckDB with Trippr's macros and name UDFs.

    remote=True loads httpfs for reading Parquet over S3/HTTPS (extraction only; tests stay offline).
    """
    con = duckdb.connect()
    run(
        con,
        f"""
        CREATE MACRO hav_km(lat1, lon1, lat2, lon2) AS
          2 * {EARTH_RADIUS_KM} * asin(sqrt(
            pow(sin(radians(lat2 - lat1) / 2), 2)
            + cos(radians(lat1)) * cos(radians(lat2)) * pow(sin(radians(lon2 - lon1) / 2), 2)
          ))
        """,
    )
    # null_handling="special": the functions receive NULLs and may return NULL (an empty name).
    con.create_function("normalize_name", normalize_name, ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("is_latin", is_latin, ["VARCHAR"], "BOOLEAN", null_handling="special")
    if remote:
        run(con, "INSTALL httpfs; LOAD httpfs;")
        if s3_region:
            run(con, f"SET s3_region = '{s3_region}'")
        run(con, "SET parquet_metadata_cache = true")
        run(con, "SET enable_http_metadata_cache = true")
    return con


def run(con: duckdb.DuckDBPyConnection, sql: str, params: list[Any] | None = None) -> list[tuple]:
    """Execute and fully fetch (DuckDB 2 requires each result to be finished)."""
    return con.execute(sql, params).fetchall() if params is not None else con.execute(sql).fetchall()


def rows(con: duckdb.DuckDBPyConnection, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
    cur = con.execute(sql, params) if params is not None else con.execute(sql)
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r, strict=True)) for r in cur.fetchall()]


def scalar(con: duckdb.DuckDBPyConnection, sql: str, params: list[Any] | None = None) -> Any:
    result = run(con, sql, params)
    return result[0][0] if result else None


def sql_str(value: str) -> str:
    """A single-quoted SQL string literal."""
    return "'" + value.replace("'", "''") + "'"
