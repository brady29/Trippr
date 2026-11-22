import pytest

from trippr_data.cities import bbox_around, haversine_km, load_cities, load_countries, select_cities
from trippr_data.duck import connect, rows, run
from trippr_data.stage import assign_cities_sql, load_cities_table


@pytest.fixture(scope="module")
def cities():
    return load_cities()


def test_every_seed_city_loads_with_a_radius(cities):
    assert len(cities) == 108
    by_code = {c.code: c for c in cities}
    assert by_code["TYO"].radius_km == 25  # default for big cities
    assert by_code["MFM"].radius_km == 10  # override in city_radius.csv
    assert all(c.country in load_countries() for c in cities)


def test_default_radius_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv("CITY_RADIUS_DEFAULT_KM", "30")
    by_code = {c.code: c for c in load_cities()}
    assert by_code["TYO"].radius_km == 30
    assert by_code["ENI"].radius_km == 10  # overrides still win


def test_bbox_encloses_the_radius(cities):
    tyo = next(c for c in cities if c.code == "TYO")
    min_lon, min_lat, max_lon, max_lat = tyo.bbox
    assert haversine_km(tyo.lat, tyo.lon, max_lat, tyo.lon) == pytest.approx(25, rel=0.01)
    assert haversine_km(tyo.lat, tyo.lon, tyo.lat, max_lon) == pytest.approx(25, rel=0.01)
    assert min_lon < tyo.lon < max_lon and min_lat < tyo.lat < max_lat
    assert bbox_around(0, 0, 111.32) == (-1.0, -1.0, 1.0, 1.0)


def test_haversine_tokyo_osaka():
    assert haversine_km(35.6812, 139.7671, 34.6937, 135.5023) == pytest.approx(403, abs=3)


def test_select_cities(cities):
    assert [c.code for c in select_cities(cities, "tyo, OSA,TYO")] == ["TYO", "OSA"]
    assert len(select_cities(cities, "all")) == 108
    with pytest.raises(ValueError, match="XXX"):
        select_cities(cities, "TYO,XXX")


@pytest.fixture()
def con(cities):
    con = connect()
    load_cities_table(con, cities, load_countries())
    run(con, "CREATE TABLE p (source_id VARCHAR, lat DOUBLE, lon DOUBLE, country VARCHAR)")
    return con


def assign(con, points):
    con.executemany("INSERT INTO p VALUES (?, ?, ?, ?)", points)
    return {r["source_id"]: (r["city_code"], r["country_ok"]) for r in rows(con, assign_cities_sql("p"))}


def test_city_assignment(con):
    result = assign(
        con,
        [
            ["tokyo-station", 35.6812, 139.7671, "JP"],
            ["far-from-everything", 40.0, 150.0, None],
            # Between Osaka (~43 km away) and Kyoto: nearest city wins
            ["fushimi-inari", 34.9671, 135.7727, "JP"],
            ["umeda", 34.7025, 135.4959, "JP"],
            # Inside both Hong Kong's and Shenzhen's circles, a little nearer Hong Kong: the record's
            # own country decides
            ["border-cn", 22.45, 114.17, "CN"],
            ["border-hk", 22.45, 114.17, "HK"],
            ["tsim-sha-tsui", 22.2988, 114.1722, "HK"],
            # Inside Macau's circle but the address says mainland China and no CN city is in range
            ["zhuhai-gongbei", 22.2210, 113.5470, "CN"],
            # No country on the record: nearest city in range
            ["unknown-country", 22.30, 114.17, None],
        ],
    )
    assert result["tokyo-station"] == ("TYO", True)
    assert result["far-from-everything"] == (None, False)
    assert result["fushimi-inari"] == ("UKY", True)
    assert result["umeda"] == ("OSA", True)
    assert result["border-cn"] == ("SZX", True)
    assert result["border-hk"] == ("HKG", True)
    assert result["tsim-sha-tsui"] == ("HKG", True)
    assert result["zhuhai-gongbei"] == ("MFM", False)
    assert result["unknown-country"] == ("HKG", True)
