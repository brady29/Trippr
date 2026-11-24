import json
import urllib.error

import duckdb
import pytest

from trippr_data.cities import load_cities, select_cities
from trippr_data.extract import osm, wikidata
from trippr_data.extract.http import HttpError, PoliteClient
from trippr_data.registry import load_registry
from trippr_data.settings import CONFIG_DIR
from trippr_data.taxonomy import load_category_map, load_taxonomy, osm_fetch_tags


@pytest.fixture(scope="module")
def osm_map():
    return load_category_map("osm", load_taxonomy())


def category(osm_map, **tags):
    key = "|".join(f"{k}={v}" for k, v in tags.items())
    return osm_map.resolve(key)


def test_osm_tags_map_to_trippr_categories(osm_map):
    assert category(osm_map, tourism="museum") == ("museum", "mapped")
    assert category(osm_map, tourism="viewpoint") == ("viewpoint", "mapped")
    assert category(osm_map, natural="peak") == ("hike", "mapped")
    assert category(osm_map, amenity="restaurant") == ("restaurant", "mapped")
    assert category(osm_map, leisure="park") == ("park_garden", "mapped")


def test_the_first_matching_rule_wins(osm_map):
    # a museum in a historic building is a museum; a castle that is also an attraction is a castle
    assert category(osm_map, tourism="museum", historic="building")[0] == "museum"
    assert category(osm_map, tourism="attraction", historic="castle")[0] == "castle_palace"
    assert category(osm_map, tourism="attraction", historic="yes")[0] == "historic_site"


def test_places_of_worship_are_split_by_religion(osm_map):
    assert category(osm_map, amenity="place_of_worship", religion="shinto")[0] == "temple_shrine"
    assert category(osm_map, amenity="place_of_worship", religion="buddhist")[0] == "temple_shrine"
    assert category(osm_map, amenity="place_of_worship", religion="christian")[0] == "place_of_worship"
    assert category(osm_map, amenity="place_of_worship")[0] == "place_of_worship"


def test_excluded_empty_and_unknown_tags(osm_map):
    assert category(osm_map, tourism="artwork") == (None, "excluded")
    assert category(osm_map, tourism="information") == (None, "excluded")
    assert category(osm_map, tourism="information", information="office") == ("tour", "mapped")
    assert osm_map.resolve("") == (None, "uncategorised")
    assert osm_map.resolve("highway=bus_stop") == (None, "unmapped")


def test_every_osm_target_is_a_taxonomy_category(osm_map):
    taxonomy = set(load_taxonomy())
    assert {v for v in osm_map.rules.values() if v != "exclude"} <= taxonomy


def test_the_overpass_query_comes_from_the_category_map(osm_map):
    fetch = osm_fetch_tags(osm_map.rules)
    assert "artwork" not in fetch["tourism"] and "museum" in fetch["tourism"]
    assert fetch["amenity"].count("place_of_worship") == 1  # compound rules fetch their first tag once
    tokyo = select_cities(load_cities(), "TYO")[0]
    query = osm.build_query(tokyo, fetch)
    assert query.startswith("[out:json][timeout:") and query.endswith("out center tags;")
    assert '  nwr["tourism"="museum"]["name"](' in query
    min_lon, min_lat, max_lon, max_lat = tokyo.bbox
    assert f"({min_lat},{min_lon},{max_lat},{max_lon})" in query
    groups = osm.query_groups(fetch)
    assert set(groups) == {"sights", "amenity", "shop", "food"}
    assert (
        groups["food"]["amenity"].count("restaurant") == 1
        and "restaurant" not in groups["amenity"]["amenity"]
    )
    assert sum(len(v) for g in groups.values() for v in g.values()) == sum(len(v) for v in fetch.values())


def test_overpass_elements_use_centres_for_ways():
    response = {
        "elements": [
            {"type": "node", "id": 1, "lat": 1.5, "lon": 2.5, "tags": {"name": "A"}},
            {"type": "way", "id": 2, "center": {"lat": 3.0, "lon": 4.0}, "tags": {"name": "B"}},
            {"type": "relation", "id": 3, "tags": {"name": "no point"}},
        ]
    }
    rows = [json.loads(line) for line in osm.elements_to_ndjson(response)]
    assert [(r["osm_type"], r["lat"], r["lon"]) for r in rows] == [("node", 1.5, 2.5), ("way", 3.0, 4.0)]


class FakeClient(PoliteClient):
    """Serves canned Overpass / SPARQL answers and records what was asked."""

    def __init__(self, handler):
        super().__init__(min_interval=0, retries=1, backoff=0, sleep=lambda s: None)
        self.handler = handler
        self.calls: list[tuple[str, dict | None]] = []

    def request(self, url, *, data=None, headers=None, retries=None):
        self.calls.append((url, data))
        return self.handler(url, data)


def overpass_handler(url, data):
    if url.endswith("/status"):
        return b"Connected as: 1\n2 slots available now.\n"
    query = data["data"]
    node = {"type": "node", "id": 11, "lat": 35.0, "lon": 139.0, "tags": {"name": "Cafe", "amenity": "cafe"}}
    way = {
        "type": "way",
        "id": 12,
        "center": {"lat": 35.001, "lon": 139.001},
        "tags": {"name": "Museum", "tourism": "museum", "wikidata": "Q1", "name:en": "The Museum"},
    }
    elements = [node] if '"amenity"' in query else [way]
    stamp = {"timestamp_osm_base": "2026-11-22T00:00:00Z"}
    return json.dumps({"osm3s": stamp, "elements": elements}).encode()


def test_osm_extract_queries_once_per_group_and_caches(tmp_path):
    tokyo = select_cities(load_cities(), "TYO")
    client = FakeClient(overpass_handler)
    meta = osm.extract(tokyo, out=tmp_path, date="2026-11-22", registry=load_registry(), client=client)
    queries = [c for c in client.calls if c[0].endswith("interpreter")]
    assert len(queries) == 4  # sights, amenity, shop, food
    # the "sights" and "shop" answers return the same museum way: it is stored once
    assert meta["files"]["TYO.parquet"]["rows"] == 2
    assert meta["licence"] == "ODbL-1.0" and "OpenStreetMap contributors" in meta["attribution"]
    again = FakeClient(overpass_handler)
    osm.extract(tokyo, out=tmp_path, date="2026-11-22", registry=load_registry(), client=again)
    assert not [c for c in again.calls if c[0].endswith("interpreter")]  # cached: nothing is queried
    path = (tmp_path / "raw/osm/2026-11-22/TYO.parquet").as_posix()
    rows = (
        duckdb.connect()
        .execute(f"SELECT osm_type || '/' || osm_id, tags['name:en'] FROM read_parquet('{path}') ORDER BY 1")
        .fetchall()
    )
    assert rows == [("node/11", None), ("way/12", "The Museum")]


def test_osm_falls_back_to_the_next_endpoint_and_reports_incomplete_runs(tmp_path):
    tokyo = select_cities(load_cities(), "TYO")

    def flaky(url, data):
        if "overpass-api.de" in url:
            raise HttpError("HTTP Error 504")
        return overpass_handler(url, data)

    client = FakeClient(flaky)
    meta = osm.extract(tokyo, out=tmp_path / "a", date="2026-11-22", registry=load_registry(), client=client)
    assert meta["files"]["TYO.parquet"]["endpoints"] == ["https://overpass.private.coffee/api/interpreter"]

    def down(url, data):
        raise HttpError("HTTP Error 502")

    with pytest.raises(osm.OverpassIncompleteError) as err:
        osm.extract(
            tokyo, out=tmp_path / "b", date="2026-11-22", registry=load_registry(), client=FakeClient(down)
        )
    assert err.value.cities == ["TYO"]


def test_polite_client_retries_and_identifies_itself(monkeypatch):
    attempts = []

    class Response:
        headers: dict = {}  # noqa: RUF012

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return b"ok"

    def fake_urlopen(req, timeout):
        attempts.append(req.get_header("User-agent"))
        if len(attempts) == 1:
            raise urllib.error.HTTPError(req.full_url, 429, "slow down", {"Retry-After": "7"}, None)
        return Response()

    slept = []
    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    client = PoliteClient(min_interval=2, retries=3, backoff=1, sleep=slept.append)
    assert client.request("https://example.test/") == b"ok"
    assert all("Trippr" in a and "github.com/brady29/Trippr" in a for a in attempts)
    assert max(slept) >= 6.9  # waited for Retry-After (minus a few microseconds of elapsed time)


# Wikidata -----------------------------------------------------------------------------------


def test_wikidata_classes_come_from_the_csv_and_exclusions_are_not_queried():
    classes = wikidata.class_qids(CONFIG_DIR)
    assert "Q845945" in classes and "Q570116" in classes
    assert "Q27686" not in classes  # hotels are excluded
    tokyo = select_cities(load_cities(), "TYO")[0]
    query = wikidata.radius_query(tokyo, ["Q33506", "Q845945"])
    assert "wikibase:around" in query and "Point(" in query
    assert "VALUES ?cls { wd:Q33506 wd:Q845945 }" in query
    assert f'wikibase:radius "{tokyo.radius_km}"' in query


def test_wikidata_wkt_points_and_uris():
    assert wikidata.parse_point("Point(139.7967 35.7148)") == (35.7148, 139.7967)
    assert wikidata.parse_point("Point(-0.1 51.5)") == (51.5, -0.1)
    assert wikidata.parse_point(None) is None
    assert wikidata.qid_of("http://www.wikidata.org/entity/Q42") == "Q42"


def binding(**values):
    return {k: {"value": v} for k, v in values.items()}


def sparql_handler(url, data):
    query = data["query"]
    if "wikibase:around" in query:
        row = binding(
            item="http://www.wikidata.org/entity/Q1",
            cls="http://www.wikidata.org/entity/Q33506",
            clsLabel="museum",
            loc="Point(139.70 35.70)",
            links="12",
        )
        return json.dumps({"results": {"bindings": [row]}}).encode()
    rows = [
        binding(
            item=f"http://www.wikidata.org/entity/{q}",
            coord="Point(139.70 35.70)",
            sitelinks="12",
            label_en=f"Place {q}",
            label_local="場所",
            description="a place",
            classes="Q33506",
        )
        for q in ("Q1", "Q2")
        if f"wd:{q}" in query
    ]
    return json.dumps({"results": {"bindings": rows}}).encode()


def test_wikidata_extract_fetches_radius_items_and_linked_qids_and_caches(tmp_path):
    tokyo = select_cities(load_cities(), "TYO")
    # an OSM raw file that names Q2 (not in the radius query) and a bogus value
    raw = tmp_path / "raw" / "osm" / "2026-11-22"
    raw.mkdir(parents=True)
    con = duckdb.connect()
    target = (raw / "TYO.parquet").as_posix()
    con.execute(
        "COPY (SELECT 'node' osm_type, 1::BIGINT osm_id, 35.7 lat, 139.7 lon, MAP {'wikidata': 'Q2'} tags "
        "UNION ALL SELECT 'node', 2, 35.7, 139.7, MAP {'wikidata': 'nope'}) "
        f"TO '{target}' (FORMAT parquet)"
    )
    (raw / "_meta.json").write_text("{}", encoding="utf-8")
    client = FakeClient(sparql_handler)
    meta = wikidata.extract(tokyo, out=tmp_path, date="2026-11-22", registry=load_registry(), client=client)
    info = meta["files"]["TYO.parquet"]
    assert (info["radius_items"], info["linked_items"]) == (1, 1)
    path = (tmp_path / "raw/wikidata/2026-11-22/TYO.parquet").as_posix()
    rows = con.execute(
        f"SELECT qid, via, sitelinks, label_local, class_qids FROM read_parquet('{path}') ORDER BY qid"
    ).fetchall()
    assert rows == [("Q1", "radius", 12, "場所", ["Q33506"]), ("Q2", "linked", 12, "場所", ["Q33506"])]
    assert meta["licence"] == "CC0-1.0"
    again = FakeClient(sparql_handler)
    wikidata.extract(tokyo, out=tmp_path, date="2026-11-22", registry=load_registry(), client=again)
    assert again.calls == []  # every query was cached
