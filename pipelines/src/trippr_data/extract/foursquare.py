"""Foursquare Open Source Places, read from a Parquet glob given by the owner.

As of 2026-11-22 the official copies need an account (Foursquare Places Portal token, or the gated
Hugging Face dataset), so the source is disabled in sources.yaml and nothing here signs up or
accepts terms. Once the owner has access, set:

  FSQ_PLACES_PATH  a Parquet glob, e.g.
                   hf://datasets/foursquare/fsq-os-places/release/dt=2026-11-17/places/parquet/*.parquet
                   or a local or s3:// copy
  HF_TOKEN         a Hugging Face token, only for hf:// paths (never logged or written to _meta.json)
  FSQ_S3_REGION    optional, for s3:// paths

Schema: https://docs.foursquare.com/data-products/docs/places-os-data-schema
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any

from ..cities import City
from ..duck import connect, run, sql_str
from ..registry import Registry
from .common import ExtractRun, bbox_filter

log = logging.getLogger(__name__)

SOURCE = "foursquare"
ENV_PATH = "FSQ_PLACES_PATH"
ENV_TOKEN = "HF_TOKEN"
COLUMNS = (
    "fsq_place_id, name, latitude, longitude, address, locality, region, postcode, admin_region, country, "
    "date_created, date_refreshed, date_closed, tel, website, fsq_category_ids, fsq_category_labels"
)


class FoursquareNotConfiguredError(RuntimeError):
    pass


def city_query(path: str, city: City) -> str:
    return (
        f"SELECT {COLUMNS} FROM read_parquet({sql_str(path)}) "
        f"WHERE {bbox_filter(city, 'longitude', 'latitude')}"
    )


def release_from_path(path: str) -> str:
    match = re.search(r"dt=(\d{4}-\d{2}-\d{2})", path)
    return match.group(1) if match else os.environ.get("FSQ_RELEASE", "unknown")


def extract(
    cities: list[City], *, out: Path, date: str, registry: Registry, path: str | None = None
) -> dict[str, Any]:
    entry = registry.require(SOURCE)
    path = path or os.environ.get(ENV_PATH)
    if not path:
        raise FoursquareNotConfiguredError(
            f"Set {ENV_PATH} to the FSQ OS Places Parquet glob (see pipelines/README.md, 'Foursquare')."
        )
    con = connect(remote=True, s3_region=os.environ.get("FSQ_S3_REGION"))
    token = os.environ.get(ENV_TOKEN)
    if path.startswith("hf://") and token:
        run(con, f"CREATE SECRET hf_token (TYPE huggingface, TOKEN {sql_str(token)})")
    release = release_from_path(path)
    log.info("foursquare release %s: %d cities", release, len(cities))
    job = ExtractRun(
        source=SOURCE,
        entry=entry,
        out=out,
        date=date,
        version=release,
        dataset_path=path,
        query_template=(
            f"SELECT {COLUMNS} FROM read_parquet('{path}') WHERE longitude BETWEEN <min_lon> AND <max_lon> "
            "AND latitude BETWEEN <min_lat> AND <max_lat>"
        ),
    )
    files = {f"{c.code}.parquet": job.write_city(con, c, city_query(path, c)) for c in cities}
    con.close()
    return job.write_meta(files)
