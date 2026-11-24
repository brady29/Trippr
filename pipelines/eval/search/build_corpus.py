"""Builds places.csv, the corpus the search relevance labels refer to.

Not run by CI. It documents how the checked-in `places.csv` was drawn from a staged run
(`pipelines/out/staging/<date>/*.parquet`, Overture + Foursquare), so it can be redrawn:

    uv run python eval/search/build_corpus.py OUT_STAGING_DIR eval/search/places.csv

The corpus has three kinds of rows:
- anchors: records of one named landmark (Sensō-ji, Taipei 101, ...), found by a name pattern within a
  city and restricted to plausible categories. The `anchor` column holds the landmark's key; name
  queries in queries.yaml are labelled with it. A landmark often appears under several names and
  scripts ("浅草寺", "Sensō-ji Temple", "浅草寺 (Sensō-ji Temple)"): all of them are relevant.
- hard negatives: records that match an anchor's name pattern but fail its category or exclusion rule
  ("Tokyo Tower Aquarium", "Yokozuna Tsutenkaku" the restaurant). They stay in the corpus, unlabelled.
- background: a seeded sample of each city's places per category, so category queries have many right
  answers and many wrong ones.

Source data: Overture Maps Places (CDLA Permissive 2.0) and Foursquare Open Source Places
(Apache 2.0); names and categories only, no coordinates.
"""

from __future__ import annotations

import csv
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import duckdb

CITIES = ["TYO", "OSA", "UKY", "SEL", "BKK", "HAN", "SGN", "TPE", "HKG", "SHA", "BJS", "CKG", "HKT", "DAD"]

# Background sample: places drawn per city and category.
SIGHT = [
    "viewpoint",
    "temple_shrine",
    "place_of_worship",
    "museum",
    "gallery",
    "landmark",
    "castle_palace",
    "historic_site",
    "monument",
    "park_garden",
    "hike",
    "beach",
    "nature_spot",
    "aquarium_zoo",
    "theme_park",
    "market",
    "onsen_spa",
    "performance",
    "nightlife",
    "sports_venue",
    "science_tech",
]
OTHER = [
    "restaurant",
    "cafe",
    "bar",
    "street_food",
    "dessert_bakery",
    "shopping",
    "cinema",
    "tour",
    "arcade_gaming",
]
PER_CELL = {"sight": 6, "other": 4}

SACRED = ["temple_shrine", "place_of_worship"]
SIGHTS = ["historic_site", "landmark", "monument", "viewpoint", "castle_palace", "museum", "tour"]


@dataclass(frozen=True)
class Anchor:
    key: str
    city: str
    pattern: str  # regex, case-insensitive, searched in name, name_local and name_en
    categories: list[str] = field(default_factory=list)
    exclude: str | None = None  # regex: records matching it are not the landmark


ANCHORS = [
    Anchor(
        "sensoji",
        "TYO",
        r"浅草寺|sens[oō]-?ji",
        [*SACRED, "tour", "historic_site"],
        r"六角堂|本坊|本堂|旧仁王門|礎石|三宝荒神|表参道|寒桜|おみくじ|駒形|スカウト|雷門|matsuri",
    ),
    Anchor(
        "tokyo_tower",
        "TYO",
        r"東京タワー|tokyo tower|東京鐵塔",
        ["historic_site", "landmark", "viewpoint"],
        r"喫煙所|ミニ|stairs|中間地|ズ$",
    ),
    Anchor("imperial_palace", "TYO", r"^(皇居|imperial palace)$", ["castle_palace", "historic_site"]),
    Anchor("shibuya_sky", "TYO", r"shibuya sky|渋谷スカイ", ["viewpoint"]),
    Anchor("osaka_castle", "OSA", r"^(osaka castle|osakajo - osaka castle)$", []),
    Anchor("kaiyukan", "OSA", r"海遊館|kaiyukan", ["aquarium_zoo"], r"サテライト|minimini"),
    Anchor(
        "usj",
        "OSA",
        r"ユニバーサル・スタジオ・ジャパン|universal studios japan",
        ["theme_park", "park_garden"],
    ),
    Anchor("kinkakuji", "UKY", r"金閣寺|kinkaku", SACRED, r"不動堂"),
    Anchor(
        "kiyomizudera",
        "UKY",
        r"清水寺",
        SACRED,
        r"西門|田村堂|北総門|納経所|釈迦堂|経堂|鐘楼|鎮守堂|本堂|子安|経書堂|写真室|高台寺",
    ),
    Anchor("fushimi_inari", "UKY", r"^伏見稲荷大社( \(.*\))?$", SACRED),
    Anchor(
        "gyeongbokgung",
        "SEL",
        r"경복궁|gyeongbokgung",
        [*SIGHTS, "castle_palace"],
        r"신무문|건춘문|영추문|야간개장|장안당|강녕전|교태전|한복|3355",
    ),
    Anchor(
        "n_seoul_tower",
        "SEL",
        r"n서울타워|n seoul tower|^namsan seoul tower$",
        ["historic_site", "viewpoint"],
    ),
    Anchor(
        "wat_arun",
        "BKK",
        r"วัดอรุณราชวราราม|wat arun",
        [*SACRED, "historic_site"],
        r"พระอุโบสถ|พระวิหาร|โบสถ์น้อย|giants|pho|ยักษ์",
    ),
    Anchor(
        "grand_palace",
        "BKK",
        r"grand palace|wat phra kaew|พระบรมมหาราชวัง|วัดพระแก้ว",
        [*SACRED, "castle_palace", "monument"],
        r"ประตู|วังหน้า|วังหลัง|สนาทหลวง|ดุสิต|veganerie|ณ พระที่นั่ง|วัดบวร",
    ),
    Anchor(
        "temple_of_literature",
        "HAN",
        r"văn miếu quốc tử giám|temple of literature",
        ["historic_site", "place_of_worship"],
    ),
    Anchor(
        "notre_dame_saigon",
        "SGN",
        r"notre[- ]dame|nhà thờ đức bà",
        ["place_of_worship", "historic_site"],
        r"hòa bình",
    ),
    Anchor("war_remnants", "SGN", r"chứng tích chiến tranh|war remnants", ["museum"]),
    Anchor("taipei_101", "TPE", r"taipei 101|台北101", ["historic_site"], r"tiffany|nightlife|pub crawl"),
    Anchor(
        "palace_museum_tw",
        "TPE",
        r"national palace museum|故宮博物院",
        ["museum"],
        r"福德宮|牌樓|administration|pushkin|行政",
    ),
    Anchor(
        "shilin",
        "TPE",
        r"士林夜市|shilin night market",
        ["market", "historic_site"],
        r"大合集|遊戲樂園|格子趣|慈誠宮|伊比利|薯條|芭樂|鯛魚燒|遺址|國際觀光|decision|辦公室|仁勇里|devil",
    ),
    Anchor(
        "avenue_of_stars",
        "HKG",
        r"avenue of stars|星光大道",
        ["historic_site", "monument"],
        r"handprint|in memory",
    ),
    Anchor(
        "tian_tan", "HKG", r"天壇大佛|tian tan buddha", ["historic_site", "tour", "hike", "temple_shrine"]
    ),
    Anchor(
        "victoria_peak",
        "HKG",
        r"太平山山頂|太平山頂|victoria peak",
        ["hike", "viewpoint", "park_garden"],
        r"纜車|觀景台|trail|pavillion",
    ),
    Anchor(
        "oriental_pearl",
        "SHA",
        r"东方明珠塔|東方明珠塔|oriental pearl tower",
        ["historic_site", "monument"],
        r"transparent",
    ),
    Anchor(
        "yu_garden",
        "SHA",
        r"yu garden|豫园|yuyuan garden",
        ["park_garden", "historic_site"],
        r"街道|mart|商城|classical",
    ),
    Anchor("shanghai_museum", "SHA", r"^(shanghai museum|上海博物馆 \| shanghai museum)$", ["museum"]),
    Anchor(
        "forbidden_city",
        "BJS",
        r"故宫|forbidden city",
        ["historic_site", "museum", "monument", "tour"],
        r"concert|西门|太和殿|tour",
    ),
    Anchor(
        "temple_of_heaven",
        "BJS",
        r"天坛|temple of heaven",
        ["historic_site", "tour", "temple_shrine", "museum"],
        r"station|gate|門|门|圆丘",
    ),
    Anchor("summer_palace", "BJS", r"颐和园", ["historic_site"], r"西门|西門"),
    Anchor("great_wall", "BJS", r"great wall|八达岭长城", ["historic_site"]),
]

COLUMNS = [
    "place_id",
    "source",
    "source_id",
    "name",
    "name_local",
    "name_en",
    "category",
    "city_code",
    "anchor",
]


def main(staging: Path, out: Path) -> None:
    con = duckdb.connect()
    path = (staging / "*.parquet").as_posix()
    con.execute(
        f"""CREATE VIEW p AS SELECT source, source_id, name, name_local, name_en, category, city_code,
            coalesce(signals.confidence, 0.5) AS conf FROM read_parquet('{path}')
            WHERE city_code IN ({",".join(repr(c) for c in CITIES)}) AND name IS NOT NULL"""
    )
    chosen: dict[tuple[str, str], dict] = {}

    def add(row: tuple, anchor: str) -> None:
        source, source_id, name, name_local, name_en, category, city = row[:7]
        key = (source, source_id)
        if key not in chosen:
            chosen[key] = {
                "place_id": f"{source}:{source_id}",
                "source": source,
                "source_id": source_id,
                "name": name,
                "name_local": name_local or "",
                "name_en": name_en or "",
                "category": category,
                "city_code": city,
                "anchor": anchor,
            }
        elif anchor:
            chosen[key]["anchor"] = anchor

    all_patterns = [re.compile(a.pattern, re.IGNORECASE) for a in ANCHORS]
    for anchor in ANCHORS:
        pattern = re.compile(anchor.pattern, re.IGNORECASE)
        exclude = re.compile(anchor.exclude, re.IGNORECASE) if anchor.exclude else None
        rows = con.execute(
            "SELECT source, source_id, name, name_local, name_en, category, city_code FROM p WHERE city_code = ?",
            [anchor.city],
        ).fetchall()
        members = hard = 0
        for row in rows:
            text = " | ".join(x for x in row[2:5] if x)
            if not pattern.search(text) and not any(pattern.search(x) for x in row[2:5] if x):
                continue
            is_member = (not anchor.categories or row[5] in anchor.categories) and not (
                exclude and exclude.search(text)
            )
            if is_member:
                add(row, anchor.key)
                members += 1
            elif hard < 12:
                add(row, "")
                hard += 1
        print(f"{anchor.key}: {members} members, {hard} hard negatives")

    for city in CITIES:
        for group, cats in (("sight", SIGHT), ("other", OTHER)):
            for category in cats:
                rows = con.execute(
                    """SELECT source, source_id, name, name_local, name_en, category, city_code FROM p
                       WHERE city_code = ? AND category = ? AND length(name) BETWEEN 2 AND 45 AND conf >= 0.8
                       ORDER BY hash(source_id) LIMIT ?""",
                    [city, category, PER_CELL[group] * 6],
                ).fetchall()
                taken = 0
                for row in rows:
                    texts = [x for x in row[2:5] if x]
                    if any(p.search(t) for p in all_patterns for t in texts):
                        continue
                    add(row, "")
                    taken += 1
                    if taken == PER_CELL[group]:
                        break

    rows_out = sorted(chosen.values(), key=lambda r: r["place_id"])
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows_out)
    print(f"{len(rows_out)} places -> {out}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
