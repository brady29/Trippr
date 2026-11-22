"""Foursquare Open Source Places, read from the gated Hugging Face dataset (or another Parquet glob).

The dataset is gated: the owner's Hugging Face account has accepted its conditions. Reading it needs
a Hugging Face token, found in this order:

  HF_TOKEN         environment variable (CI uses the repository secret of the same name)
  hf auth login    the token cached by the Hugging Face CLI (~/.cache/huggingface/token), read by
                   DuckDB's credential chain, so it never passes through this code

Optional:
  FSQ_PLACES_PATH  a different Parquet glob (a newer release, or a local or s3:// copy)
  FSQ_S3_REGION    for s3:// paths

The token is never logged or written to _meta.json.

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


# Newest release on the dataset when this was checked (2026-11-22); override with FSQ_PLACES_PATH.
DEFAULT_PATH = "hf://datasets/foursquare/fsq-os-places/release/dt=2026-11-17/places/parquet/*.parquet"
HF_TOKEN_CACHE = Path.home() / ".cache" / "huggingface" / "token"


class FoursquareNotConfiguredError(RuntimeError):
    pass


def has_hf_token() -> bool:
    """True when a Hugging Face token is available (env var or the CLI's cached login)."""
    cache = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "token"
    return bool(os.environ.get(ENV_TOKEN)) or cache.exists() or HF_TOKEN_CACHE.exists()


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
    path = path or os.environ.get(ENV_PATH) or DEFAULT_PATH
    if path.startswith("hf://") and not has_hf_token():
        raise FoursquareNotConfiguredError(
            "No Hugging Face token: run `hf auth login` (or set HF_TOKEN) with an account that has "
            "access to foursquare/fsq-os-places. See pipelines/README.md, 'Foursquare'."
        )
    con = connect(remote=True, s3_region=os.environ.get("FSQ_S3_REGION"))
    token = os.environ.get(ENV_TOKEN)
    if path.startswith("hf://"):
        if token:
            run(con, f"CREATE SECRET hf_token (TYPE huggingface, TOKEN {sql_str(token)})")
        else:
            run(con, "CREATE SECRET hf_token (TYPE huggingface, PROVIDER credential_chain)")
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
