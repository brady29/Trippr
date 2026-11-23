import bz2
import json
from xml.sax.saxutils import escape

import duckdb

from trippr_data.cities import load_cities, select_cities
from trippr_data.extract import wikivoyage as wv
from trippr_data.registry import load_registry

ARTICLE = """== See ==
* {{see | name=[[Senso-ji]] | alt=浅草寺 | url=http://www.senso-ji.jp/ | address=2-3-1 Asakusa
| lat=35.7148 | long=139.7967 | directions=Asakusa Station | phone=+81 3-3842-0181 | hours=6AM-5PM
| wikidata=Q273600 | wikipedia=Sensō-ji | content=Tokyo's oldest temple, with a [[Nakamise]] shopping street.<ref>x</ref> {{flag|Japan}} '''Free'''.
}}
* {{do | name=Sumida River cruise | lat=35.71 | long=139.80 | content=Boats leave every 30 minutes.}}
* {{eat | name=Daikokuya | lat= | long= | content=Tempura since 1887.}}
* {{listing | type=drink | name=Bar Sample | lat=999 | long=999 | wikidata=not-a-qid}}
* {{sleep | name=Hotel Fixture | lat=35.7 | long=139.7}}
* {{see | name=}}
* {{see | name=Senso-ji | lat=35.7148 | long=139.7967}}
Some text with {{nested {{template}} here}} and {{Quote|text}}.
"""


def test_templates_are_found_at_the_top_level_only():
    found = list(wv.iter_templates("a {{x|{{y}}|[[z|w]]}} b {{q}}"))
    assert found == ["{{x|{{y}}|[[z|w]]}}", "{{q}}"]


def test_params_split_outside_nested_templates_and_links():
    assert wv.split_params("see | name=[[A|B]] | content={{c|d}} e") == [
        "see ",
        " name=[[A|B]] ",
        " content={{c|d}} e",
    ]


def test_listing_fields_are_parsed_and_cleaned():
    listings = wv.listings_in_page(7, "Tokyo/Asakusa", "2026-10-01T00:00:00Z", ARTICLE)
    by_name = {(r["name"], r["listing_type"]): r for r in listings}
    senso = by_name[("Senso-ji", "see")]
    assert senso["alt"] == "浅草寺"
    assert (senso["lat"], senso["lon"]) == (35.7148, 139.7967)
    assert senso["wikidata"] == "Q273600"
    assert senso["url"] == "http://www.senso-ji.jp/"
    assert senso["hours"] == "6AM-5PM"
    # links become their label, refs and inner templates go, bold markup goes
    assert senso["content"] == "Tokyo's oldest temple, with a Nakamise shopping street. Free."
    assert senso["article"] == "Tokyo/Asakusa" and senso["page_id"] == 7


def test_missing_bad_and_duplicate_values():
    listings = wv.listings_in_page(7, "Tokyo", None, ARTICLE)
    types = [(r["name"], r["listing_type"]) for r in listings]
    assert ("Daikokuya", "eat") in types
    daikokuya = next(r for r in listings if r["name"] == "Daikokuya")
    assert daikokuya["lat"] is None and daikokuya["lon"] is None  # empty coordinates
    drink = next(r for r in listings if r["name"] == "Bar Sample")
    assert drink["listing_type"] == "drink"  # {{listing|type=drink}}
    assert drink["lat"] is None  # 999 is not a coordinate
    assert drink["wikidata"] is None  # not a QID
    assert len([r for r in listings if r["name"] == "Senso-ji"]) == 1  # the repeated listing collapses
    assert not any(r["name"] is None for r in listings)  # `{{see|name=}}` has no name


def test_city_articles_and_districts_map_to_cities():
    keys = wv.city_keys(load_cities())
    assert wv.article_city("Tokyo", keys) == "TYO"
    assert wv.article_city("Tokyo/Shibuya", keys) == "TYO"
    assert wv.article_city("Naha", keys) == "OKA"  # "Naha (Okinawa)"
    assert wv.article_city("Atlantis", keys) is None


def test_listing_ids_are_stable_and_distinct():
    a, b = wv.listings_in_page(7, "Tokyo", None, ARTICLE)[:2]
    assert wv.listing_id(a) == wv.listing_id(a) and wv.listing_id(a) != wv.listing_id(b)


def page_xml(page_id, title, text, ns=0, redirect=False):
    redirect_tag = '<redirect title="Elsewhere" />' if redirect else ""
    return (
        f"<page><title>{title}</title><ns>{ns}</ns><id>{page_id}</id>{redirect_tag}"
        f"<revision><timestamp>2026-10-01T00:00:00Z</timestamp><text>{text}</text></revision></page>"
    )


def test_extract_reads_a_dump_and_assigns_cities_by_coordinates(tmp_path):
    xml = (
        '<mediawiki xmlns="http://www.mediawiki.org/xml/export-0.11/">'
        + page_xml(1, "Tokyo/Asakusa", escape(ARTICLE))
        + page_xml(2, "Talk:Tokyo", escape(ARTICLE), ns=1)
        + page_xml(3, "Redirect", escape(ARTICLE), redirect=True)
        + page_xml(4, "Osaka", "{{see | name=Osaka Castle | lat=34.6873 | long=135.5262}}")
        + "</mediawiki>"
    )
    dump = tmp_path / "dump.xml.bz2"
    dump.write_bytes(bz2.compress(xml.encode()))
    cities = select_cities(load_cities(), "TYO,OSA")
    meta = wv.extract(cities, out=tmp_path / "out", date="2026-11-22", registry=load_registry(), dump=dump)
    assert meta["files"]["TYO.parquet"]["rows"] >= 3
    con = duckdb.connect()
    tokyo = con.execute(
        f"SELECT name, lat IS NULL FROM read_parquet('{(tmp_path / 'out/raw/wikivoyage/2026-11-22/TYO.parquet').as_posix()}')"
    ).fetchall()
    assert ("Senso-ji", False) in tokyo
    assert ("Daikokuya", True) in tokyo  # no coordinates, but inside a Tokyo article: kept for the count
    assert meta["files"]["TYO.parquet"]["listings_without_coordinates"] >= 1
    osaka = con.execute(
        f"SELECT name FROM read_parquet('{(tmp_path / 'out/raw/wikivoyage/2026-11-22/OSA.parquet').as_posix()}')"
    ).fetchall()
    assert osaka == [("Osaka Castle",)]
    manifest = json.loads((tmp_path / "out/raw/wikivoyage/2026-11-22/_meta.json").read_text(encoding="utf-8"))
    assert manifest["licence"] == "CC-BY-SA-4.0" and manifest["content_licence"] == "CC-BY-SA-4.0"
