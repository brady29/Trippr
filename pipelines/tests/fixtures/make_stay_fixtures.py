"""Build the stay fixtures under tests/fixtures/stay/ (deterministic; rerun after changing the design).

    uv run python tests/fixtures/make_stay_fixtures.py

Everything is small and offline:
- raw/overture: the lodging rows of the real PR 1 fixture (Tokyo and Osaka) plus synthetic variants
- raw/foursquare, raw/osm_lodging: SYNTHETIC hotels placed near those rows to exercise merging
- raw/insideairbnb: SYNTHETIC listings for Tokyo and Singapore in the real file formats (gz CSV, calendar,
  reviews summary, neighbourhoods with polygons). Not real Airbnb data.
- raw/boc_fx: rates in the Bank of Canada Valet response shape (values rounded from the real September 2026 ones)
- places/places.parquet: SYNTHETIC staged places around the Shibuya and Asakusa areas for walkability
See tests/fixtures/README.md.
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import random
import shutil
from datetime import date, timedelta
from pathlib import Path

import duckdb

HERE = Path(__file__).parent
BASE_OVERTURE = HERE / "data" / "raw" / "overture" / "2026-11-18"
OUT = HERE / "stay"
DATE = "2026-11-18"
FETCHED_AT = "2026-11-18T06:00:00+00:00"
SNAPSHOTS = {"TYO": "2026-09-25", "SIN": "2026-09-23"}


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def sha256(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_meta(
    directory: Path, source: str, licence: str, version: str, files: dict[str, dict], **extra
) -> None:
    meta = {
        "source": source,
        "licence": licence,
        "version": version,
        "dataset_path": "fixture",
        "run_date": DATE,
        "fetched_at": FETCHED_AT,
        "row_count": sum((f.get("rows") or 0) for f in files.values()),
        "fixture": True,
        **extra,
        "files": dict(sorted(files.items())),
    }
    write_text(directory / "_meta.json", json.dumps(meta, ensure_ascii=False, indent=2) + "\n")


# --- hotels ------------------------------------------------------------------------------------------


def overture_rows() -> None:
    directory = OUT / "raw" / "overture" / DATE
    directory.mkdir(parents=True)
    con = duckdb.connect()
    for city in ("TYO", "OSA"):
        src = (BASE_OVERTURE / f"{city}.parquet").as_posix()
        target = (directory / f"{city}.parquet").as_posix()
        extra = ""
        if city == "TYO":
            # A ryokan next to Asakusa, a duplicate of the Tokyu Stay 12 m away (same-source merge), a closed place.
            extra = f"""
            UNION ALL SELECT * REPLACE (
                'fixture-ryokan' AS id,
                struct_update(names, "primary" := 'Asakusa Fixture Ryokan') AS names,
                struct_update(taxonomy, "primary" := 'ryokan', hierarchy := ['lodging', 'ryokan']) AS taxonomy,
                struct_update(bbox, xmin := 139.7965, xmax := 139.7965, ymin := 35.7142, ymax := 35.7142) AS bbox)
              FROM read_parquet('{src}') WHERE id = 'ac1204cb-a733-49f9-b3c0-a5644d9705e6'
            UNION ALL SELECT * REPLACE (
                'fixture-tokyu-twin' AS id,
                struct_update(bbox, xmin := 139.70524, xmax := 139.70524, ymin := 35.65478, ymax := 35.65478) AS bbox)
              FROM read_parquet('{src}') WHERE id = 'ac1204cb-a733-49f9-b3c0-a5644d9705e6'
            UNION ALL SELECT * REPLACE ('fixture-closed' AS id, 'permanently_closed' AS operating_status,
                struct_update(bbox, xmin := 139.80, xmax := 139.80, ymin := 35.71, ymax := 35.71) AS bbox)
              FROM read_parquet('{src}') WHERE id = 'ac1204cb-a733-49f9-b3c0-a5644d9705e6'
            """
        con.execute(
            f"""COPY (SELECT * FROM read_parquet('{src}') WHERE taxonomy.hierarchy[1] = 'lodging' {extra}
                      ORDER BY id) TO '{target}' (FORMAT parquet)"""
        ).fetchall()
    files = {}
    for p in sorted(directory.glob("*.parquet")):
        n = con.execute(f"SELECT count(*) FROM read_parquet('{p.as_posix()}')").fetchall()[0][0]
        files[p.name] = {"city": p.stem, "rows": n, "sha256": sha256(p), "fetched_at": FETCHED_AT}
    write_meta(
        directory,
        "overture",
        "CDLA-Permissive-2.0 AND Apache-2.0 AND CC0-1.0",
        "2026-11-18.0",
        files,
    )


def foursquare_rows() -> None:
    directory = OUT / "raw" / "foursquare" / DATE
    directory.mkdir(parents=True)
    rows = {
        "TYO": [
            # (id, name, lat, lon, label, closed)
            (
                "fsq-tokyu",
                "Tokyu Stay Shibuya Shin-Minamiguchi",
                35.65490,
                139.70490,
                "Travel and Transportation > Lodging > Hotel",
                None,
            ),
            (
                "fsq-shibuya-hostel",
                "Shibuya Fixture Hostel",
                35.6600,
                139.7010,
                "Travel and Transportation > Lodging > Hostel",
                None,
            ),
            (
                "fsq-camp",
                "Fixture Campground",
                35.62,
                139.75,
                "Travel and Transportation > Lodging > Campground",
                None,
            ),
            ("fsq-other", "Fixture Lodging", 35.69, 139.72, "Travel and Transportation > Lodging", None),
            (
                "fsq-closed",
                "Closed Fixture Inn",
                35.68,
                139.76,
                "Travel and Transportation > Lodging > Inn",
                "2026-01-05",
            ),
            ("fsq-restaurant", "Fixture Ramen", 35.68, 139.77, "Dining and Drinking > Restaurant", None),
        ],
        "OSA": [
            (
                "fsq-shin-osaka",
                "Shin-Osaka Hotel",
                34.73350,
                135.50340,
                "Travel and Transportation > Lodging > Hotel",
                None,
            ),
            (
                "fsq-bnb",
                "Fixture B&B Osaka",
                34.69,
                135.50,
                "Travel and Transportation > Lodging > Bed and Breakfast",
                None,
            ),
        ],
    }
    con = duckdb.connect()
    files = {}
    for city, items in rows.items():
        con.execute(
            """CREATE OR REPLACE TABLE t (fsq_place_id VARCHAR, name VARCHAR, latitude DOUBLE, longitude DOUBLE,
               address VARCHAR, locality VARCHAR, region VARCHAR, postcode VARCHAR, admin_region VARCHAR, country VARCHAR,
               date_created DATE, date_refreshed DATE, date_closed DATE, tel VARCHAR, website VARCHAR,
               fsq_category_ids VARCHAR[], fsq_category_labels VARCHAR[])"""
        )
        for fid, name, lat, lon, label, closed in items:
            con.execute(
                "INSERT INTO t VALUES (?, ?, ?, ?, '1-2-3 Fixture', ?, NULL, '100-0001', NULL, 'JP', DATE '2020-01-01', DATE '2026-10-01', ?, NULL, ?, ['x'], [?])",
                [
                    fid,
                    name,
                    lat,
                    lon,
                    "Tokyo" if city == "TYO" else "Osaka",
                    closed,
                    "https://example.com/" + fid,
                    label,
                ],
            )
        path = directory / f"{city}.parquet"
        con.execute(f"COPY (SELECT * FROM t ORDER BY fsq_place_id) TO '{path.as_posix()}' (FORMAT parquet)")
        files[path.name] = {
            "city": city,
            "rows": len(items),
            "sha256": sha256(path),
            "fetched_at": FETCHED_AT,
        }
    write_meta(directory, "foursquare", "Apache-2.0", "fixture", files)


def osm_rows() -> None:
    directory = OUT / "raw" / "osm_lodging" / DATE
    directory.mkdir(parents=True)

    def el(kind, i, lat, lon, **tags):
        item = {"type": kind, "id": i, "tags": tags}
        if kind == "node":
            item.update(lat=lat, lon=lon)
        else:
            item["center"] = {"lat": lat, "lon": lon}
        return item

    data = {
        "TYO": [
            el(
                "node",
                101,
                35.65484,
                139.70506,
                tourism="hotel",
                name="Tokyu Stay Shibuya Shin-Minamiguchi",
                stars="3",
                website="https://www.tokyustay.example/shibuya",
                wikidata="Q111",
                **{"name:en": "Tokyu Stay Shibuya Shin-Minamiguchi", "addr:country": "JP"},
            ),
            el(
                "way",
                202,
                35.69425,
                139.76457,
                tourism="hotel",
                name="ANA Holiday Inn Tokyo Bay",
                stars="4",
                phone="+81 3 0000 0000",
            ),
            el(
                "node",
                303,
                35.7150,
                139.7960,
                tourism="guest_house",
                name="浅草ゲストハウス",
                **{
                    "name:en": "Asakusa Guest House",
                    "name:ja": "浅草ゲストハウス",
                    "addr:street": "Kaminarimon",
                    "addr:housenumber": "1",
                },
            ),
            el(
                "node",
                304,
                35.71503,
                139.79604,
                tourism="guest_house",
                name="浅草ゲストハウス",
                **{"name:en": "Asakusa Guest House"},
            ),
            el(
                "node",
                305,
                35.7000,
                139.7000,
                tourism="apartment",
                name="Shinjuku Fixture Apartments",
                stars="2S",
            ),
            el("node", 306, 35.7100, 139.8100, tourism="hostel", name="Fixture Hostel Sumida"),
            el("node", 307, 35.7200, 139.8200, tourism="hotel"),  # no name: dropped
            el("node", 308, 35.6000, 139.6000, tourism="chalet", name="Fixture Chalet"),  # excluded kind
            el("node", 309, 38.0, 139.7, tourism="hotel", name="Too Far Hotel"),  # outside every city
        ],
        "OSA": [
            el("node", 401, 34.69880, 135.53530, tourism="hostel", name="Lucky's hostel"),
            el(
                "node",
                402,
                34.70,
                135.51,
                tourism="motel",
                name="Fixture Motel Osaka",
                **{"addr:country": "JP"},
            ),
        ],
    }
    files = {}
    for city, elements in data.items():
        path = directory / f"{city}.json"
        body = {
            "version": 0.6,
            "generator": "Overpass API fixture",
            "osm3s": {"timestamp_osm_base": "2026-11-17T22:00:00Z"},
            "elements": elements,
        }
        write_text(path, json.dumps(body, ensure_ascii=False, indent=1) + "\n")
        files[path.name] = {
            "city": city,
            "rows": len(elements),
            "osm_base": "2026-11-17T22:00:00Z",
            "sha256": sha256(path),
            "fetched_at": FETCHED_AT,
        }
    write_meta(directory, "osm_lodging", "ODbL-1.0", "2026-11-17T22:00:00Z", files)


# --- Inside Airbnb -----------------------------------------------------------------------------------

LISTING_COLUMNS = [
    "id",
    "listing_url",
    "last_scraped",
    "name",
    "description",
    "host_id",
    "host_name",
    "neighbourhood_cleansed",
    "neighbourhood_group_cleansed",
    "latitude",
    "longitude",
    "property_type",
    "room_type",
    "accommodates",
    "bathrooms_text",
    "bedrooms",
    "beds",
    "price",
    "minimum_nights",
    "availability_30",
    "availability_60",
    "availability_90",
    "availability_365",
    "number_of_reviews",
    "number_of_reviews_ltm",
    "estimated_occupancy_l365d",
    "review_scores_rating",
    "review_scores_location",
    "review_scores_value",
    "license",
    "instant_bookable",
    "calculated_host_listings_count",
]


def fmt_price(local: float | None, rng: random.Random) -> str:
    return "" if local is None else f"${local:,.2f}"


def make_city(
    code: str, snapshot: str, clusters: list[dict], rng: random.Random, currency_scale: float
) -> list[dict]:
    rows = []
    listing_id = {"TYO": 1000, "SIN": 5000}[code]
    for cl in clusters:
        for _ in range(cl["n"]):
            listing_id += 1
            room = rng.choices(
                ["Entire home/apt", "Private room", "Shared room", "Hotel room"], [60, 30, 5, 5]
            )[0]
            local = round(rng.uniform(*cl["price"]) / currency_scale) * currency_scale
            if room == "Private room":
                local *= 0.6
            reviews = rng.choice([0, 0, 1, 3, 8, 12, 25, 40, 80])
            ltm = min(reviews, rng.choice([0, 1, 2, 5, 9]))
            rows.append(
                {
                    "id": listing_id,
                    "listing_url": f"https://www.airbnb.com/rooms/{listing_id}",
                    "last_scraped": snapshot,
                    "name": f"Fixture listing {listing_id}",
                    "description": 'A "quiet" place,\nwith a second line, and commas',
                    "host_id": 7 if (listing_id % 11 == 0 and code == "TYO") else 9000 + listing_id,
                    "host_name": "Fixture Host",
                    "neighbourhood_cleansed": cl["name"],
                    "neighbourhood_group_cleansed": cl.get("group", ""),
                    "latitude": round(cl["lat"] + rng.uniform(-0.0045, 0.0045), 5),
                    "longitude": round(cl["lon"] + rng.uniform(-0.0045, 0.0045), 5),
                    "property_type": "Entire rental unit"
                    if room == "Entire home/apt"
                    else "Private room in rental unit",
                    "room_type": room,
                    "accommodates": rng.randint(1, 6),
                    "bathrooms_text": "1 bath",
                    "bedrooms": rng.randint(1, 3),
                    "beds": rng.randint(1, 4),
                    "price": fmt_price(local, rng),
                    "minimum_nights": rng.choice([1, 1, 2, 2, 3, 3, 5]),
                    "availability_30": rng.randint(0, 30),
                    "availability_60": rng.randint(0, 60),
                    "availability_90": rng.randint(0, 90),
                    "availability_365": rng.randint(0, 365),
                    "number_of_reviews": reviews,
                    "number_of_reviews_ltm": ltm,
                    "estimated_occupancy_l365d": rng.randint(10, 300),
                    "review_scores_rating": "" if reviews == 0 else round(rng.uniform(4.0, 5.0), 2),
                    "review_scores_location": "" if reviews == 0 else round(rng.uniform(4.2, 5.0), 2),
                    "review_scores_value": "" if reviews == 0 else round(rng.uniform(4.0, 5.0), 2),
                    "license": "M130001234" if rng.random() < 0.6 and code == "TYO" else "",
                    "instant_bookable": "t",
                    "calculated_host_listings_count": 6 if (listing_id % 11 == 0 and code == "TYO") else 1,
                }
            )
    return rows


def edge_cases(code: str, rows: list[dict]) -> None:
    """Hand-picked rows: missing price, a price under the floor, a runaway price, long stays, bad coordinates."""
    rows[1]["price"] = ""
    rows[2]["price"] = ""
    rows[3]["price"] = "$0.00"
    rows[4]["price"] = "$3.00" if code == "TYO" else "$1.00"  # CAD under the floor
    rows[5]["price"] = "$2,500,000.00" if code == "TYO" else "$90,000.00"  # above the 99th percentile
    for k in (6, 7, 8):
        rows[k]["minimum_nights"] = 30
    rows[9]["minimum_nights"] = 90
    rows[10]["room_type"] = "Something new"


def write_listings(path: Path, rows: list[dict]) -> None:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=LISTING_COLUMNS, extrasaction="ignore", lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    with open(path, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
        gz.write(buf.getvalue().encode("utf-8"))


def rect(lat: float, lon: float, d: float = 0.005) -> dict:
    ring = [
        [lon - d, lat - d],
        [lon + d, lat - d],
        [lon + d, lat + d],
        [lon - d, lat + d],
        [lon - d, lat - d],
    ]
    return {"type": "Polygon", "coordinates": [ring]}


def airbnb() -> None:
    directory = OUT / "raw" / "insideairbnb" / DATE
    rng = random.Random(2026)
    cities = {
        "TYO": [
            {
                "name": "Shibuya Ku",
                "lat": 35.659,
                "lon": 139.700,
                "n": 40,
                "price": (15000, 40000),
                "group": "",
            },
            {"name": "Taito Ku", "lat": 35.715, "lon": 139.797, "n": 40, "price": (8000, 20000), "group": ""},
            {
                "name": "Shinjuku Ku",
                "lat": 35.690,
                "lon": 139.700,
                "n": 35,
                "price": (10000, 25000),
                "group": "",
            },
            {
                "name": "Ogasawara Mura",
                "lat": 27.09,
                "lon": 142.19,
                "n": 2,
                "price": (12000, 15000),
                "group": "",
            },
        ],
        "SIN": [
            {
                "name": "Kallang",
                "lat": 1.311,
                "lon": 103.866,
                "n": 16,
                "price": (90, 300),
                "group": "Central Region",
            },
            {
                "name": "Geylang",
                "lat": 1.315,
                "lon": 103.887,
                "n": 9,
                "price": (80, 200),
                "group": "Central Region",
            },
            {
                "name": "Tampines",
                "lat": 1.345,
                "lon": 103.959,
                "n": 3,
                "price": (60, 90),
                "group": "East Region",
            },
        ],
    }
    centres = {"TYO": (35.6812, 139.7671), "SIN": (1.2900, 103.8500)}
    files: dict[str, dict] = {}
    for code, clusters in cities.items():
        snapshot = SNAPSHOTS[code]
        rows = make_city(code, snapshot, clusters, rng, 500 if code == "TYO" else 1)
        edge_cases(code, rows)
        city_dir = directory / code
        city_dir.mkdir(parents=True)
        write_listings(city_dir / "listings.csv.gz", rows)

        # Calendar: 40 days from the snapshot date; a listing is blocked on some days.
        buf = io.StringIO()
        buf.write("listing_id,date,available,minimum_nights,maximum_nights\n")
        first = date.fromisoformat(snapshot)
        for r in rows:
            for day in range(40):
                blocked = (r["id"] + day) % 3 == 0 if r["id"] % 5 else day < 30
                buf.write(
                    f"{r['id']},{first + timedelta(days=day)},{'f' if blocked else 't'},{r['minimum_nights']},1125\n"
                )
        with (
            open(city_dir / "calendar.csv.gz", "wb") as raw,
            gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz,
        ):
            gz.write(buf.getvalue().encode())

        # Reviews summary: ltm dates inside the last year, the rest older.
        lines = ["listing_id,date"]
        snap = date.fromisoformat(snapshot)
        for r in rows:
            for k in range(r["number_of_reviews_ltm"]):
                lines.append(f"{r['id']},{snap - timedelta(days=10 + 37 * k)}")
            for k in range(r["number_of_reviews"] - r["number_of_reviews_ltm"]):
                lines.append(f"{r['id']},{snap - timedelta(days=400 + 45 * k)}")
        write_text(city_dir / "reviews.csv", "\n".join(lines) + "\n")

        # Neighbourhoods: names and rectangles (area known from the geometry).
        nb_lines = (
            ["neighbourhood_group,neighbourhood"]
            + [f"{c.get('group', '')},{c['name']}" for c in clusters]
            + [f"{clusters[0].get('group', '')},Empty Fixture Ward"]
        )
        write_text(city_dir / "neighbourhoods.csv", "\n".join(nb_lines) + "\n")
        features = [
            {
                "type": "Feature",
                "properties": {"neighbourhood": c["name"], "neighbourhood_group": c.get("group", "")},
                "geometry": rect(c["lat"], c["lon"]),
            }
            for c in clusters
        ]
        write_text(
            city_dir / "neighbourhoods.geojson",
            json.dumps({"type": "FeatureCollection", "features": features}) + "\n",
        )

        for name in (
            "listings.csv.gz",
            "calendar.csv.gz",
            "reviews.csv",
            "neighbourhoods.csv",
            "neighbourhoods.geojson",
        ):
            p = city_dir / name
            counted = name in ("listings.csv.gz", "calendar.csv.gz", "reviews.csv")
            n = (
                duckdb.connect()
                .execute(f"SELECT count(*) FROM read_csv('{p.as_posix()}', all_varchar=true)")
                .fetchall()[0][0]
                if counted
                else None
            )
            files[f"{code}/{name}"] = {
                "city": code,
                "name": name,
                "snapshot": snapshot,
                "url": f"fixture://{code}/{name}",
                "bytes": p.stat().st_size,
                "sha256": sha256(p),
                "rows": n,
                "fetched_at": FETCHED_AT,
            }
    write_meta(
        directory,
        "insideairbnb",
        "CC-BY-4.0",
        max(SNAPSHOTS.values()),
        files,
        attribution="Data from Inside Airbnb (insideairbnb.com), CC BY 4.0. Location and snapshot date are shown with every figure.",
        snapshots=dict(sorted(SNAPSHOTS.items())),
        coverage={"covered": ["SIN", "TYO"], "not_covered_in_this_run": []},
        row_count=sum(f["rows"] for f in files.values() if f["name"] == "listings.csv.gz"),
    )
    _ = centres


def fx() -> None:
    directory = OUT / "raw" / "boc_fx" / DATE
    directory.mkdir(parents=True)
    obs = []
    for d in range(14, 29):
        day = date(2026, 9, d)
        if day.weekday() >= 5:
            continue
        obs.append(
            {
                "d": str(day),
                "FXJPYCAD": {"v": f"{0.00890 + 0.00001 * (d - 14):.6f}"},
                "FXSGDCAD": {"v": f"{1.0964 + 0.001 * (d - 14):.4f}"},
            }
        )
    path = directory / "rates.json"
    write_text(
        path,
        json.dumps({"terms": {"url": "https://www.bankofcanada.ca/terms/"}, "observations": obs}, indent=1)
        + "\n",
    )
    write_meta(
        directory,
        "boc_fx",
        "Bank of Canada Terms of Use (free use with attribution)",
        "2026-09-28",
        {"rates.json": {"city": None, "rows": len(obs), "sha256": sha256(path), "fetched_at": FETCHED_AT}},
    )


# --- staged places for walkability -------------------------------------------------------------------


def places() -> None:
    rng = random.Random(7)
    rows = []

    def cluster(lat, lon, n, nightlife, prefix):
        for i in range(n):
            cat = (
                "bar"
                if i < nightlife
                else rng.choice(["restaurant", "cafe", "museum", "temple_shrine", "market", "shopping"])
            )
            rows.append(
                (
                    "TYO",
                    round(lat + rng.uniform(-0.004, 0.004), 6),
                    round(lon + rng.uniform(-0.004, 0.004), 6),
                    cat,
                )
            )

    cluster(35.659, 139.700, 70, 14, "shibuya")  # dense and noisy
    cluster(35.715, 139.797, 12, 0, "asakusa")  # sparse and quiet
    cluster(35.690, 139.700, 45, 5, "shinjuku")
    rows.append(("OSA", 34.69, 135.50, "restaurant"))
    path = OUT / "places" / "places.parquet"
    path.parent.mkdir(parents=True)
    con = duckdb.connect()
    con.execute("CREATE TABLE p (city_code VARCHAR, lat DOUBLE, lon DOUBLE, category VARCHAR)")
    con.executemany("INSERT INTO p VALUES (?, ?, ?, ?)", rows)
    con.execute(
        f"COPY (SELECT * FROM p ORDER BY city_code, lat, lon) TO '{path.as_posix()}' (FORMAT parquet)"
    ).fetchall()


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    overture_rows()
    foursquare_rows()
    osm_rows()
    airbnb()
    fx()
    places()
    print("written", OUT)


if __name__ == "__main__":
    main()
