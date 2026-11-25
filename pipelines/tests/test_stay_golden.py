"""Golden test for the stay stages: fixtures in, hotels / unit scores / summary out, compared with checked-in files.

After an intended change to the stay stages or config/stay_score.yaml, regenerate with
    UPDATE_GOLDEN=1 uv run pytest tests/test_stay_golden.py
and review the diff.
"""

from __future__ import annotations

import csv
import io
import json
import os
from pathlib import Path

import duckdb
import pytest

from trippr_data.layout import read_json
from trippr_data.stay import checks as stay_checks
from trippr_data.stay.layout import stay_stats_file, stay_summary_file, stay_table
from trippr_data.stay.report import stay_section

from .conftest import FIXTURE_DATE, FIXTURES

EXPECTED = FIXTURES / "expected" / "stay"


def csv_of(out: Path, name: str, select: str, order: str) -> str:
    con = duckdb.connect()
    cur = con.execute(
        f"SELECT {select} FROM read_parquet('{stay_table(out, FIXTURE_DATE, name).as_posix()}') ORDER BY {order}"
    )
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow([d[0] for d in cur.description])
    writer.writerows(cur.fetchall())
    return buf.getvalue()


HOTEL_SELECT = (
    "hotel_id, name, name_en, kind, stars, wikidata_qid, city_code, round(lat, 5) AS lat, round(lon, 5) AS lon, "
    "array_to_string(sources, ';') AS sources, n_sources, area_id, area_dist_km"
)
UNIT_SELECT = (
    "unit_kind, unit_id, n_listings, n_priced, n_rated, median_price_cad, median_price_entire_cad, median_price_pp_cad, "
    "entire_home_share, median_rating, reviews_ltm, unavailable_share, multi_host_share, top_hosts_share, "
    "listing_density_km2, n_hotels, n_places, n_nightlife, cheaper_than_share, score_value, score_reviews, "
    "score_centrality, score_walkability, score_quiet, stay_score, centre_km, station_km, array_to_string(score_parts, ';') AS score_parts, weight_coverage, "
    "low_sample, explanation"
)


def test_golden_stay(stay_out, registry):
    passed, results = stay_checks.check(stay_out, FIXTURE_DATE, registry=registry, baseline=None)
    airbnb = read_json(stay_stats_file(stay_out, FIXTURE_DATE, "airbnb"))
    hotel = read_json(stay_stats_file(stay_out, FIXTURE_DATE, "hotel"))
    summary = read_json(stay_summary_file(stay_out, FIXTURE_DATE))
    actual = {
        "hotel.csv": csv_of(stay_out, "hotel", HOTEL_SELECT, "city_code, hotel_id"),
        "stay_unit.csv": csv_of(stay_out, "stay_unit", UNIT_SELECT, "unit_kind, unit_id"),
        "summary.json": json.dumps(
            {
                "airbnb_per_city": airbnb["per_city"],
                "hotel": {
                    k: hotel[k]
                    for k in (
                        "hotels",
                        "multi_source",
                        "with_area",
                        "with_stars",
                        "by_kind",
                        "per_city",
                        "per_area",
                        "merge",
                    )
                },
                "hotel_sources": {
                    s: {k: v for k, v in st.items() if k != "unmapped_top"}
                    for s, st in hotel["sources"].items()
                },
                "summary": summary,
                "checks": {r.name: r.status for r in results},
            },
            indent=2,
            sort_keys=True,
            ensure_ascii=False,
        )
        + "\n",
        "report.md": "\n".join(stay_section(stay_out, FIXTURE_DATE, registry)) + "\n",
    }
    if os.environ.get("UPDATE_GOLDEN"):
        EXPECTED.mkdir(parents=True, exist_ok=True)
        for name, text in actual.items():
            (EXPECTED / name).write_text(text, encoding="utf-8", newline="\n")
        pytest.skip("golden files updated")
    assert passed
    for name, text in actual.items():
        assert text == (EXPECTED / name).read_text(encoding="utf-8"), f"{name} differs from the golden file"
