"""Overture Maps Places: GeoParquet on public S3, read with DuckDB and a bounding box per city.

Docs checked 2026-11-22:
- https://docs.overturemaps.org/getting-data/ (release paths, STAC catalog)
- https://docs.overturemaps.org/schema/reference/places/place/ (schema v2: taxonomy, basic_category)
- https://docs.overturemaps.org/guides/places/ (categories removed in Sept 2026; use taxonomy)
- https://docs.overturemaps.org/attribution/ (licences per provider)
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from ..cities import City
from ..duck import connect, scalar, sql_str
from ..registry import Registry
from .common import ExtractRun, bbox_filter

log = logging.getLogger(__name__)

SOURCE = "overture"
STAC_CATALOG = "https://stac.overturemaps.org/catalog.json"
S3_REGION = "us-west-2"
PLACES_PATH = "s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*"

# Columns kept from the place type. Points have bbox xmin = xmax and ymin = ymax, so bbox carries the
# coordinates and lets DuckDB skip row groups outside the city. emails and socials are not needed.
COLUMNS = (
    "id, names, basic_category, taxonomy, confidence, websites, phones, addresses, sources, "
    "operating_status, brand, bbox, version"
)


def city_query(path: str, city: City) -> str:
    return (
        f"SELECT {COLUMNS} FROM read_parquet({sql_str(path)}) "
        f"WHERE {bbox_filter(city, 'bbox.xmin', 'bbox.ymin')}"
    )


def latest_release(con: Any) -> str:
    return str(scalar(con, f"SELECT latest FROM read_json_auto({sql_str(STAC_CATALOG)})"))


def extract(
    cities: list[City], *, out: Path, date: str, registry: Registry, release: str | None = None
) -> dict[str, Any]:
    entry = registry.require(SOURCE)
    con = connect(remote=True, s3_region=S3_REGION)
    release = release or os.environ.get("OVERTURE_RELEASE") or latest_release(con)
    path = PLACES_PATH.format(release=release)
    log.info("overture release %s: %d cities", release, len(cities))
    job = ExtractRun(
        source=SOURCE,
        entry=entry,
        out=out,
        date=date,
        version=release,
        dataset_path=path,
        query_template=(
            f"SELECT {COLUMNS} FROM read_parquet('{path}') WHERE bbox.xmin BETWEEN <min_lon> AND <max_lon> "
            "AND bbox.ymin BETWEEN <min_lat> AND <max_lat>"
        ),
        extra={"release_catalog": STAC_CATALOG, "schema_docs": "https://docs.overturemaps.org/schema/"},
    )
    files = {f"{c.code}.parquet": job.write_city(con, c, city_query(path, c)) for c in cities}
    con.close()
    return job.write_meta(files)
