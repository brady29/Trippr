"""Inside Airbnb, Bank of Canada and OSM lodging extractors against a local HTTP server (no internet)."""

from __future__ import annotations

import json
import threading
import urllib.parse
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from trippr_data.cities import load_cities, select_cities
from trippr_data.extract import boc_fx, insideairbnb, osm_lodging
from trippr_data.extract.polite_http import HttpError, PoliteClient, RobotsDisallowedError, quote_url
from trippr_data.layout import read_json

from .conftest import FIXTURE_DATE, STAY_FIXTURES

RAW = STAY_FIXTURES / "raw" / "insideairbnb" / FIXTURE_DATE
INDEX_LINKS = {
    ("japan", "kantō", "tokyo"): ["2026-06-20", "2026-09-25"],
    ("singapore", "sg", "singapore"): ["2026-09-23"],
    ("japan", "kansai", "osaka-fixture"): ["2026-09-01"],  # a dataset in a Trippr country we have not mapped
    ("france", "idf", "paris"): ["2026-09-10"],
}


class Site:
    """A tiny web server. `routes` maps a decoded path to (status, headers, body) or a callable giving one."""

    def __init__(self) -> None:
        self.routes: dict[str, object] = {}
        self.hits: list[tuple[str, str]] = []  # (path, user agent)
        site = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self, body_in: bytes | None = None) -> None:
                path = urllib.parse.unquote(self.path.split("?")[0])
                site.hits.append((path, self.headers.get("User-Agent", "")))
                route = site.routes.get(path)
                if callable(route):
                    route = route(body_in)
                if route is None:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status, headers, body = route  # type: ignore[misc]
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                if "Content-Length" not in headers:
                    self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:
                self._serve()

            def do_POST(self) -> None:
                n = int(self.headers.get("Content-Length", 0))
                self._serve(self.rfile.read(n))

            def log_message(self, *args) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def __enter__(self) -> Site:
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def site() -> Iterator[Site]:
    with Site() as s:
        yield s


def fast_client(**kw) -> PoliteClient:
    slept: list[float] = []
    client = PoliteClient(min_interval_s=0.0, backoff_s=0.0, sleep=slept.append, **kw)
    client.slept = slept  # type: ignore[attr-defined]
    return client


def index_html(base: str) -> str:
    links = []
    for (country, region, city), dates in INDEX_LINKS.items():
        for d in dates:
            links.append(
                f'<a href="{base}/{country}/{region}/{city}/{d}/data/listings.csv.gz">listings.csv.gz</a>'
            )
            links.append(
                f'<a href="{base}/{country}/{region}/{city}/{d}/data/calendar.csv.gz">calendar.csv.gz</a>'
            )
    return "<html><body>" + "\n".join(links) + "</body></html>"


def serve_airbnb(site: Site) -> None:
    site.routes["/robots.txt"] = (
        200,
        {"Content-Type": "text/plain"},
        b"User-agent: ia_archiver\nDisallow: /get-the-data\n",
    )
    site.routes["/get-the-data/"] = (200, {"Content-Type": "text/html"}, index_html(site.base).encode())
    for code, region in (
        ("TYO", "japan/kantō/tokyo/2026-09-25"),
        ("SIN", "singapore/sg/singapore/2026-09-23"),
    ):
        for name, rel in insideairbnb.SNAPSHOT_FILES.items():
            body = (RAW / code / name).read_bytes()
            site.routes[f"/{region}/{rel}"] = (200, {"Content-Length": str(len(body))}, body)


# --- index parsing ------------------------------------------------------------------------------------


def test_parse_index_finds_the_snapshots_of_each_dataset():
    html = (
        index_html(insideairbnb.DATA_HOST)
        + '<a href="https://example.com/x/y/z/2026-01-01/data/listings.csv.gz">other host</a>'
    )
    index = insideairbnb.parse_index(html)
    assert index[("japan", "kantō", "tokyo")] == ["2026-06-20", "2026-09-25"]
    assert ("x", "y", "z") not in index
    encoded = html.replace("kantō", "kant%C5%8D")
    assert ("japan", "kantō", "tokyo") in insideairbnb.parse_index(encoded)


def test_unmapped_datasets_in_trippr_countries_are_reported():
    index = insideairbnb.parse_index(index_html(insideairbnb.DATA_HOST))
    unmapped = insideairbnb.unmapped_datasets(index, insideairbnb.load_city_map(), load_cities())
    assert unmapped == [("japan", "kansai", "osaka-fixture")]  # france is not one of Trippr's countries


def test_city_map_covers_exactly_the_five_known_cities():
    mapping = insideairbnb.load_city_map()
    assert sorted(mapping) == ["BKK", "HKG", "SIN", "TPE", "TYO"]
    assert {m.currency for m in mapping.values()} == {"JPY", "HKD", "SGD", "TWD", "THB"}
    assert {c.code for c in load_cities()} >= set(mapping)


def test_quote_url_encodes_non_ascii_paths():
    assert quote_url("https://h/japan/kantō/tokyo/x.gz") == "https://h/japan/kant%C5%8D/tokyo/x.gz"


# --- the polite client --------------------------------------------------------------------------------


def test_client_sends_a_generic_user_agent_and_obeys_robots(site):
    site.routes["/robots.txt"] = (200, {}, b"User-agent: *\nDisallow: /private/\n")
    site.routes["/public"] = (200, {}, b"ok")
    site.routes["/private/x"] = (200, {}, b"no")
    client = fast_client()
    assert client.get_bytes(site.base + "/public") == b"ok"
    with pytest.raises(RobotsDisallowedError):
        client.get_bytes(site.base + "/private/x")
    ua = {u for _, u in site.hits}
    assert len(ua) == 1 and "TrippRData" in ua.pop()
    assert ("/private/x", "") not in [(p, "") for p, _ in site.hits]  # never requested


def test_client_retries_busy_responses_and_then_gives_up(site):
    calls = {"n": 0}

    def flaky(_body):
        calls["n"] += 1
        return (503, {"Retry-After": "7"}, b"busy") if calls["n"] < 3 else (200, {}, b"fine")

    site.routes["/flaky"] = flaky
    site.routes["/down"] = (503, {}, b"busy")
    client = fast_client(check_robots=False)
    assert client.get_bytes(site.base + "/flaky") == b"fine"
    assert client.slept.count(7.0) == 2  # Retry-After was honoured
    with pytest.raises(HttpError, match="failed after"):
        client.get_bytes(site.base + "/down")
    site.routes["/gone"] = (404, {}, b"")
    with pytest.raises(HttpError, match="HTTP 404"):
        client.get_bytes(site.base + "/gone")


def test_client_spaces_requests(site):
    site.routes["/a"] = (200, {}, b"a")
    now = [0.0]
    slept: list[float] = []

    def sleep(s: float) -> None:
        slept.append(s)
        now[0] += s

    client = PoliteClient(min_interval_s=2.0, sleep=sleep, monotonic=lambda: now[0], check_robots=False)
    client.get_bytes(site.base + "/a")
    client.get_bytes(site.base + "/a")
    assert slept == [2.0]


def test_download_checks_the_size_and_leaves_no_partial_file(site, tmp_path):
    site.routes["/short"] = (200, {"Content-Length": "100"}, b"x" * 10)
    site.routes["/whole"] = (200, {}, b"hello")
    client = fast_client(check_robots=False, retries=1)
    size, sha = client.download(site.base + "/whole", tmp_path / "d" / "whole.bin")
    assert size == 5 and len(sha) == 64 and (tmp_path / "d" / "whole.bin").read_bytes() == b"hello"
    with pytest.raises(HttpError):
        client.download(site.base + "/short", tmp_path / "short.bin")
    assert not list(tmp_path.glob("short.bin*"))


# --- Inside Airbnb extraction -------------------------------------------------------------------------


def run_extract(site: Site, out: Path, registry, cities: str = "TYO,SIN,OSA", **kw):
    selected = select_cities(load_cities(), cities)
    return insideairbnb.extract(
        selected,
        out=out,
        date=FIXTURE_DATE,
        registry=registry,
        client=fast_client(),
        index_url=site.base + "/get-the-data/",
        data_host=site.base,
        **kw,
    )


def test_extract_downloads_the_newest_snapshot_of_covered_cities(site, registry, tmp_path):
    serve_airbnb(site)
    meta = run_extract(site, tmp_path, registry)
    assert meta["snapshots"] == {"SIN": "2026-09-23", "TYO": "2026-09-25"}  # the newer Tokyo snapshot
    assert meta["coverage"]["covered"] == ["SIN", "TYO"]
    assert meta["coverage"]["not_covered_in_this_run"] == ["OSA"]  # Inside Airbnb has no Osaka dataset
    assert meta["licence"] == "CC-BY-4.0" and "Inside Airbnb" in meta["attribution"]
    assert meta["row_count"] == 145 and "TrippRData" in meta["user_agent"]
    fixture_meta = read_json(RAW / "_meta.json")
    assert set(fixture_meta) - {"fixture"} <= set(
        meta
    )  # the checked-in fixture manifest is a subset of the extractor manifest
    for rel, f in meta["files"].items():
        assert (tmp_path / "raw/insideairbnb" / FIXTURE_DATE / rel).read_bytes() == (RAW / rel).read_bytes()
        assert f["sha256"] == fixture_meta["files"][rel]["sha256"] and set(f) == set(
            fixture_meta["files"][rel]
        )
    assert all(ua.startswith("TrippRData") for _, ua in site.hits)


def test_a_second_run_does_not_download_again(site, registry, tmp_path):
    serve_airbnb(site)
    run_extract(site, tmp_path, registry)
    data_hits = [p for p, _ in site.hits if "/data/" in p or "/visualisations/" in p]
    assert len(data_hits) == 10
    run_extract(site, tmp_path, registry)
    again = [p for p, _ in site.hits if "/data/" in p or "/visualisations/" in p]
    assert len(again) == 10  # nothing new was fetched
    run_extract(site, tmp_path, registry, force=True)
    assert len([p for p, _ in site.hits if "/data/" in p or "/visualisations/" in p]) == 20


def test_a_corrupted_raw_file_is_fetched_again(site, registry, tmp_path):
    serve_airbnb(site)
    run_extract(
        site,
        tmp_path,
        registry,
    )
    target = tmp_path / "raw/insideairbnb" / FIXTURE_DATE / "SIN" / "neighbourhoods.csv"
    target.write_text("changed", encoding="utf-8")
    run_extract(site, tmp_path, registry)
    assert target.read_bytes() == (RAW / "SIN" / "neighbourhoods.csv").read_bytes()


def test_extract_stops_when_robots_forbids_the_data_host(site, registry, tmp_path):
    serve_airbnb(site)
    site.routes["/robots.txt"] = (200, {}, b"User-agent: *\nDisallow: /\n")
    with pytest.raises(RobotsDisallowedError):
        run_extract(site, tmp_path, registry)


def test_extract_and_stage_work_together(site, registry, tmp_path):
    from trippr_data.stay.airbnb import stage_airbnb

    serve_airbnb(site)
    insideairbnb_meta = run_extract(site, tmp_path, registry)
    needs = insideairbnb.fx_needs(insideairbnb_meta, insideairbnb.load_city_map())
    assert needs == (["JPY", "SGD"], "2026-09-23", "2026-09-25")
    rates = (STAY_FIXTURES / "raw/boc_fx" / FIXTURE_DATE / "rates.json").read_bytes()
    site.routes["/valet/observations/FXJPYCAD,FXSGDCAD/json"] = (200, {}, rates)
    meta = boc_fx.extract(
        ["JPY", "SGD"],
        "2026-09-23",
        "2026-09-25",
        out=tmp_path,
        date=FIXTURE_DATE,
        registry=registry,
        client=fast_client(check_robots=False),
    )
    assert meta["currencies"] == ["JPY", "SGD"]
    stats = stage_airbnb(tmp_path, FIXTURE_DATE, registry=registry)
    assert stats["listings"] == 145


# --- exchange rates -----------------------------------------------------------------------------------


def test_rates_use_the_last_business_day_on_or_before_the_date():
    rates = boc_fx.load_rates(STAY_FIXTURES / "raw/boc_fx" / FIXTURE_DATE / "rates.json")
    friday = boc_fx.rate_on(rates, "JPY", "2026-09-25")
    sunday = boc_fx.rate_on(rates, "JPY", "2026-09-27")  # a Sunday: Friday's rate
    assert friday is not None and sunday == friday and friday[1] == "2026-09-25"
    assert boc_fx.rate_on(rates, "CAD", "2026-09-27") == (1.0, "2026-09-27")
    assert boc_fx.rate_on(rates, "THB", "2026-09-25") is None  # no such series
    assert boc_fx.rate_on(rates, "JPY", "2026-12-01") is None  # too far from any observation
    assert boc_fx.series_id("jpy") == "FXJPYCAD"


# --- OSM lodging --------------------------------------------------------------------------------------


def test_osm_lodging_query_and_extract(site, registry, tmp_path):
    city = select_cities(load_cities(), "TYO")[0]
    q = osm_lodging.city_query(city)
    assert 'nwr["tourism"~"^(hotel|hostel|guest_house|apartment|motel)$"]' in q and "out center tags" in q
    body = (STAY_FIXTURES / "raw/osm_lodging" / FIXTURE_DATE / "TYO.json").read_bytes()
    seen: list[bytes] = []

    def overpass(post):
        seen.append(post)
        return 200, {}, body

    site.routes["/api/interpreter"] = overpass
    meta = osm_lodging.extract(
        [city],
        out=tmp_path,
        date=FIXTURE_DATE,
        registry=registry,
        client=fast_client(check_robots=False),
        endpoint=site.base + "/api/interpreter",
    )
    assert meta["row_count"] == 9 and meta["licence"] == "ODbL-1.0"
    assert b"data=" in seen[0] and meta["files"]["TYO.json"]["osm_base"] == "2026-11-17T22:00:00Z"
    assert json.loads((tmp_path / "raw/osm_lodging" / FIXTURE_DATE / "TYO.json").read_text(encoding="utf-8"))[
        "elements"
    ]
