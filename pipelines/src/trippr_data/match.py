"""Match: entity resolution across the staged sources (docs/data-platform-spec.md, "Entity resolution").

Per city:
1. Blocking: records of different sources in the same or neighbouring geohash-7 cells (a cell is
   360/2^18 degrees, about 150 m) within 500 m, with compatible category families.
2. Strong links: the same Wikidata QID, or the same website (host, and first path segment on shared
   hosts such as facebook.com) within 300 m. A QID or website used by several places of one source (a
   chain) is not a strong link.
3. Scored pairs: 0.55 name + 0.30 distance + 0.15 category + 0.15 bonus for a matching phone or address,
   all hand-set in MatchConfig. Name similarity is the best of Jaro-Winkler and a length-weighted token
   set measure over every name / name_en / name_local variant pair; distance is 1 under 75 m and falls
   linearly to 0 at 500 m. A pair needs name similarity >= 0.5 (or a matching phone) to count.
4. Pruning: a scored pair is kept when each record is the other's best match in its source, or its score
   is very high (>= 0.92).
5. Clustering: union-find over the accepted pairs, strongest first; a merge that would make the cluster
   wider than 500 m is refused (the spread guard).
6. Survivorship: one golden record per cluster with field-level source precedence and `sources[]`.

Writes matched/<date>/links.parquet (source record -> cluster id, score, rule), golden.parquet and
match.stats.json.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import duckdb

from .cities import haversine_km
from .duck import connect, run, scalar, sql_str
from .layout import golden_file, links_file, match_stats_file, staged_file, staged_sources, write_json
from .registry import Registry
from .settings import CONFIG_DIR
from .similarity import address_key, name_key, name_tokens, phone_key, website_key

log = logging.getLogger(__name__)

CELL_DEGREES = 360 / 2**18  # a geohash-7 cell is 18 bits of longitude and 17 of latitude: 0.001373 degrees

# Field-level source precedence for golden records (lower is better, first available wins).
PRECEDENCE: dict[str, list[str]] = {
    "name": ["wikidata", "wikivoyage", "osm", "overture", "foursquare"],
    "name_en": ["wikidata", "wikivoyage", "osm", "overture", "foursquare"],
    "name_local": ["wikidata", "osm", "overture", "foursquare", "wikivoyage"],
    "coords": ["osm", "overture", "foursquare", "wikidata", "wikivoyage"],
    "website": ["overture", "wikidata", "osm", "foursquare", "wikivoyage"],
    "phone": ["overture", "osm", "foursquare", "wikivoyage", "wikidata"],
    "address": ["overture", "osm", "foursquare", "wikivoyage", "wikidata"],
    "opening_hours": ["osm", "wikivoyage", "overture", "foursquare", "wikidata"],
    "category": ["osm", "wikidata", "overture", "foursquare", "wikivoyage"],
    "description": ["wikivoyage", "wikidata", "osm", "overture", "foursquare"],
    "wikidata_qid": ["osm", "wikivoyage", "wikidata", "overture", "foursquare"],
    "wikipedia_url": ["wikidata", "wikivoyage", "osm", "overture", "foursquare"],
}
GENERIC_CATEGORIES = ("landmark", "tour")


@dataclass(frozen=True)
class MatchConfig:
    """Hand-set weights and limits. Changing them changes the golden output; the eval reports the effect."""

    w_name: float = 0.55
    w_dist: float = 0.30
    w_cat: float = 0.15
    contact_bonus: float = 0.15
    threshold: float = 0.78
    name_floor: float = 0.5
    full_score_m: float = 75.0
    zero_score_m: float = 500.0
    max_spread_m: float = 500.0
    strong_website_m: float = 300.0
    chain_max_per_source: int = 3
    high_score: float = 0.92
    other_family_category_score: float = 0.5
    jw_floor: float = 0.7  # Jaro-Winkler below this is noise; above it is rescaled to 0..1


# ---------------------------------------------------------------------------------------------
# Connection, per-city tables
# ---------------------------------------------------------------------------------------------


def open_match_connection(
    out: Path, date: str, sources: list[str], temp_dir: Path | None = None
) -> duckdb.DuckDBPyConnection:
    con = connect()
    con.create_function("name_key", name_key, ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("name_tokens", name_tokens, ["VARCHAR"], "VARCHAR[]", null_handling="special")
    con.create_function("website_key", website_key, ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("phone_key", phone_key, ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("address_key", address_key, ["VARCHAR"], "VARCHAR", null_handling="special")
    if temp_dir:
        temp_dir.mkdir(parents=True, exist_ok=True)
        run(con, f"SET temp_directory = {sql_str(temp_dir.as_posix())}")
    run(con, "SET memory_limit = '3GB'")
    files = ", ".join(sql_str(staged_file(out, date, s).as_posix()) for s in sources)
    run(con, f"CREATE VIEW staged AS SELECT * FROM read_parquet([{files}], union_by_name = true)")
    return con


def load_families(con: duckdb.DuckDBPyConnection, config_dir: Path = CONFIG_DIR) -> dict[str, int]:
    """category -> bitmask of its families (two categories are compatible when their masks overlap)."""
    import csv

    with open(config_dir / "category_family.csv", encoding="utf-8", newline="") as fh:
        table = list(csv.DictReader(line for line in fh if line.strip() and not line.startswith("#")))
    names = sorted({f for r in table for f in r["families"].split()})
    bit = {f: 1 << i for i, f in enumerate(names)}
    masks = {r["category"]: sum(bit[f] for f in r["families"].split()) for r in table}
    run(con, "CREATE OR REPLACE TABLE catfam (category VARCHAR, mask INTEGER)")
    con.executemany("INSERT INTO catfam VALUES (?, ?)", list(masks.items()))
    return masks


def prepare_city(con: duckdb.DuckDBPyConnection, city: str, cfg: MatchConfig) -> int:
    """Create `recs` (one row per staged record of the city, with comparison keys) and return its size."""
    run(
        con,
        f"""CREATE OR REPLACE TABLE recs AS
            SELECT s.source || ':' || s.source_id AS rid, s.source, s.source_id,
                   s.name, s.name_en, s.name_local, s.category, f.mask,
                   s.lat, s.lon,
                   CAST(floor((s.lon + 180) / {CELL_DEGREES}) AS BIGINT) AS gx,
                   CAST(floor((s.lat + 90) / {CELL_DEGREES}) AS BIGINT) AS gy,
                   s.wikidata_qid AS qid, website_key(s.website) AS wkey, phone_key(s.phone) AS pkey,
                   address_key(s.address) AS akey
            FROM staged s JOIN catfam f ON f.category = s.category
            WHERE s.city_code = {sql_str(city)}""",
    )
    # chain guards: a QID or website used by several places of one source is a brand, not an identity
    run(
        con,
        f"""CREATE OR REPLACE TABLE recs_g AS
            SELECT *,
              count(*) OVER (PARTITION BY source, qid) > {cfg.chain_max_per_source} AS qid_chain,
              count(*) OVER (PARTITION BY source, wkey) > {cfg.chain_max_per_source} AS web_chain
            FROM recs""",
    )
    run(con, "DROP TABLE recs")
    run(con, "ALTER TABLE recs_g RENAME TO recs")
    return int(scalar(con, "SELECT count(*) FROM recs"))


def candidate_pairs(con: duckdb.DuckDBPyConnection, cfg: MatchConfig) -> int:
    """Create `cand`: pairs of records of different sources in neighbouring cells, within 500 m, with
    compatible categories."""
    run(
        con,
        f"""CREATE OR REPLACE TABLE cand AS
            WITH cells AS (
              SELECT r.rid, r.source, r.mask, r.lat, r.lon, r.gx + dx.d AS cx, r.gy + dy.d AS cy
              FROM recs r, (VALUES (-1), (0), (1)) dx(d), (VALUES (-1), (0), (1)) dy(d))
            SELECT c.rid AS ra, b.rid AS rb,
                   1000 * hav_km(c.lat, c.lon, b.lat, b.lon) AS dist_m
            FROM cells c JOIN recs b ON b.gx = c.cx AND b.gy = c.cy AND b.source > c.source
            WHERE (c.mask & b.mask) <> 0
              AND 1000 * hav_km(c.lat, c.lon, b.lat, b.lon) <= {cfg.zero_score_m}""",
    )
    return int(scalar(con, "SELECT count(*) FROM cand"))


def score_candidates(con: duckdb.DuckDBPyConnection, cfg: MatchConfig) -> None:
    """Create `scored` from `cand`: name similarity, distance score, category score, contact match, score."""
    run(
        con,
        """CREATE OR REPLACE TABLE variants AS
           SELECT rid, key, name_tokens(key) AS tok,
                  coalesce(list_sum(list_transform(name_tokens(key), lambda t: len(t))), 0) AS tw
           FROM (SELECT DISTINCT rid, name_key(v) AS key FROM (
                   SELECT rid, unnest([name, name_en, name_local]) AS v FROM recs
                   WHERE rid IN (SELECT ra FROM cand UNION SELECT rb FROM cand))
                 WHERE v IS NOT NULL) WHERE key IS NOT NULL""",
    )
    run(
        con,
        f"""CREATE OR REPLACE TABLE name_sims AS
           SELECT c.ra, c.rb,
             max(CASE
               WHEN va.key = vb.key THEN 1.0
               WHEN least(len(va.key), len(vb.key)) <= 2 THEN
                 CASE WHEN starts_with(CASE WHEN len(va.key) >= len(vb.key) THEN va.key ELSE vb.key END,
                                       CASE WHEN len(va.key) >= len(vb.key) THEN vb.key ELSE va.key END)
                      THEN 0.8 ELSE 0.0 END
               ELSE greatest(
                 greatest(0.0, (jaro_winkler_similarity(va.key, vb.key) - {cfg.jw_floor}) / (1.0 - {cfg.jw_floor})),
                 CASE WHEN va.tw + vb.tw = 0 THEN 0.0 ELSE
                   2.0 * coalesce(list_sum(list_transform(list_intersect(va.tok, vb.tok), lambda t: len(t))), 0)
                   / (va.tw + vb.tw) END)
             END) AS name_sim
           FROM cand c JOIN variants va ON va.rid = c.ra JOIN variants vb ON vb.rid = c.rb
           GROUP BY c.ra, c.rb""",
    )
    run(
        con,
        f"""CREATE OR REPLACE TABLE scored AS
           SELECT c.ra, c.rb, c.dist_m, coalesce(n.name_sim, 0.0) AS name_sim,
             greatest(0.0, least(1.0, ({cfg.zero_score_m} - c.dist_m) / ({cfg.zero_score_m} - {cfg.full_score_m})))
               AS dist_score,
             CASE WHEN a.category = b.category THEN 1.0 ELSE {cfg.other_family_category_score} END AS cat_score,
             (a.pkey IS NOT NULL AND a.pkey = b.pkey) AS phone_match,
             (a.akey IS NOT NULL AND a.akey = b.akey) AS addr_match,
             a.source AS sa, b.source AS sb
           FROM cand c
           JOIN recs a ON a.rid = c.ra JOIN recs b ON b.rid = c.rb
           LEFT JOIN name_sims n ON n.ra = c.ra AND n.rb = c.rb""",
    )
    # score is added separately so the threshold sweep can re-run only the cheap part
    run(
        con,
        f"""ALTER TABLE scored ADD COLUMN score DOUBLE;
            UPDATE scored SET score = least(1.0, {cfg.w_name} * name_sim + {cfg.w_dist} * dist_score
                 + {cfg.w_cat} * cat_score
                 + {cfg.contact_bonus} * CASE WHEN phone_match OR addr_match THEN 1 ELSE 0 END)""",
    )


def strong_links(con: duckdb.DuckDBPyConnection, cfg: MatchConfig) -> None:
    """Create `strong`: pairs sharing a (non-chain) Wikidata QID, or a (non-chain) website within 300 m."""
    run(
        con,
        f"""CREATE OR REPLACE TABLE strong AS
            SELECT a.rid AS ra, b.rid AS rb, 'strong_qid' AS rule,
                   1000 * hav_km(a.lat, a.lon, b.lat, b.lon) AS dist_m
            FROM recs a JOIN recs b ON a.qid = b.qid AND a.rid < b.rid
            WHERE a.qid IS NOT NULL AND NOT a.qid_chain AND NOT b.qid_chain
            UNION ALL
            SELECT a.rid, b.rid, 'strong_website', 1000 * hav_km(a.lat, a.lon, b.lat, b.lon)
            FROM recs a JOIN recs b ON a.wkey = b.wkey AND a.source < b.source
            WHERE a.wkey IS NOT NULL AND NOT a.web_chain AND NOT b.web_chain
              AND 1000 * hav_km(a.lat, a.lon, b.lat, b.lon) <= {cfg.strong_website_m}""",
    )


def accepted_edges(
    con: duckdb.DuckDBPyConnection, cfg: MatchConfig
) -> list[tuple[str, str, float, str, float]]:
    """(a, b, score, rule, dist_m) of every edge that may join records: strong links, then pruned scored pairs."""
    run(
        con,
        f"""CREATE OR REPLACE TABLE ok AS
            SELECT * FROM scored
            WHERE score >= {cfg.threshold} AND (name_sim >= {cfg.name_floor} OR phone_match)""",
    )
    run(
        con,
        """CREATE OR REPLACE TABLE ranked AS
            SELECT *,
              row_number() OVER (PARTITION BY ra, sb ORDER BY score DESC, rb) AS rank_a,
              row_number() OVER (PARTITION BY rb, sa ORDER BY score DESC, ra) AS rank_b
            FROM ok""",
    )
    result = run(
        con,
        f"""SELECT ra, rb, 1.0 AS score, rule, dist_m FROM strong
            UNION ALL
            SELECT ra, rb, score,
                   CASE WHEN phone_match THEN 'scored_phone' WHEN addr_match THEN 'scored_address'
                        ELSE 'scored' END,
                   dist_m
            FROM ranked
            WHERE (rank_a = 1 AND rank_b = 1 OR score >= {cfg.high_score})
              AND NOT EXISTS (SELECT 1 FROM strong s WHERE s.ra = ranked.ra AND s.rb = ranked.rb)""",
    )
    return result


# ---------------------------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------------------------


def _dist_m(p: tuple[float, float], q: tuple[float, float]) -> float:
    return 1000 * haversine_km(p[0], p[1], q[0], q[1])


class SpreadGuardedClusters:
    """Union-find that refuses a merge when the merged cluster would be wider than max_spread_m."""

    def __init__(self, coords: dict[str, tuple[float, float]], max_spread_m: float) -> None:
        self.coords = coords
        self.max_spread_m = max_spread_m
        self.parent: dict[str, str] = {}
        self.members: dict[str, list[str]] = {}
        self.refused = 0

    def find(self, x: str) -> str:
        self.parent.setdefault(x, x)
        self.members.setdefault(x, [x])
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:
            self.parent[x], x = root, self.parent[x]
        return root

    def _wide(self, a: list[str], b: list[str]) -> bool:
        if len(a) * len(b) > 4000:  # very large clusters: compare each member with the other's centre only
            pts = [self.coords[m] for m in a + b]
            lat0 = sum(p[0] for p in pts) / len(pts)
            lon0 = sum(p[1] for p in pts) / len(pts)
            return any(_dist_m((lat0, lon0), p) > self.max_spread_m / 2 for p in pts)
        return any(_dist_m(self.coords[x], self.coords[y]) > self.max_spread_m for x in a for y in b)

    def union(self, a: str, b: str) -> bool:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return True
        if self._wide(self.members[ra], self.members[rb]):
            self.refused += 1
            return False
        if len(self.members[ra]) < len(self.members[rb]):
            ra, rb = rb, ra
        self.parent[rb] = ra
        self.members[ra].extend(self.members.pop(rb))
        return True


def cluster_id(city: str, rid: str) -> str:
    return f"{city}-{hashlib.md5(rid.encode()).hexdigest()[:10]}"


def cluster_edges(
    city: str,
    edges: list[tuple[str, str, float, str, float]],
    coords: dict[str, tuple[float, float]],
    cfg: MatchConfig,
) -> tuple[dict[str, tuple[str, float, str]], dict[str, int]]:
    """record -> (cluster id, best edge score, rule) for every record that joined a cluster, and counters."""
    guard = SpreadGuardedClusters(coords, cfg.max_spread_m)
    strong_first = sorted(edges, key=lambda e: (not e[3].startswith("strong"), -e[2], e[0], e[1]))
    best: dict[str, tuple[float, str]] = {}
    merged = 0
    for a, b, score, rule, _ in strong_first:
        if guard.union(a, b):
            merged += 1
            for r in (a, b):
                if r not in best or (score, rule.startswith("strong")) > (
                    best[r][0],
                    best[r][1].startswith("strong"),
                ):
                    best[r] = (score, rule)
    result: dict[str, tuple[str, float, str]] = {}
    for r in best:
        members = guard.members[guard.find(r)]
        cid = cluster_id(city, min(members))
        result[r] = (cid, best[r][0], best[r][1])
    return result, {"edges": len(edges), "merged": merged, "refused_by_spread": guard.refused}


# ---------------------------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------------------------


def _create_output_tables(con: duckdb.DuckDBPyConnection) -> None:
    run(
        con,
        """CREATE OR REPLACE TABLE links (rid VARCHAR, source VARCHAR, source_id VARCHAR, city_code VARCHAR,
           cluster_id VARCHAR, score DOUBLE, rule VARCHAR)""",
    )
    run(con, "CREATE OR REPLACE TABLE merged (rid VARCHAR, cluster_id VARCHAR, score DOUBLE, rule VARCHAR)")


def match_city(con: duckdb.DuckDBPyConnection, city: str, cfg: MatchConfig) -> dict[str, Any]:
    """Match one city's records; appends to `links`. Returns the city's counters."""
    started = time.monotonic()
    n = prepare_city(con, city, cfg)
    stats: dict[str, Any] = {"records": n}
    if n == 0:
        return stats
    stats["candidates"] = candidate_pairs(con, cfg)
    score_candidates(con, cfg)
    strong_links(con, cfg)
    edges = accepted_edges(con, cfg)
    coords = {r: (lat, lon) for r, lat, lon in run(con, "SELECT rid, lat, lon FROM recs")}
    assigned, counters = cluster_edges(city, edges, coords, cfg)
    stats.update(counters)
    stats["strong_edges"] = sum(1 for e in edges if e[3].startswith("strong"))
    run(con, "DELETE FROM merged")
    if assigned:
        con.executemany(
            "INSERT INTO merged VALUES (?, ?, ?, ?)",
            [[r, cid, s, rule] for r, (cid, s, rule) in assigned.items()],
        )
    run(
        con,
        f"""INSERT INTO links
            SELECT r.rid, r.source, r.source_id, {sql_str(city)},
                   coalesce(m.cluster_id, {sql_str(city)} || '-' || substr(md5(r.rid), 1, 10)),
                   m.score, coalesce(m.rule, 'singleton')
            FROM recs r LEFT JOIN merged m USING (rid)""",
    )
    stats["seconds"] = round(time.monotonic() - started, 1)
    return stats


def _prec_case(field: str) -> str:
    order = PRECEDENCE[field]
    whens = " ".join(f"WHEN source = '{s}' THEN {i}" for i, s in enumerate(order))
    return f"CASE {whens} ELSE {len(order)} END"


def build_golden(con: duckdb.DuckDBPyConnection, out: Path, date: str) -> None:
    """Create `golden` from `links` and the staged records, with per-field survivorship."""
    run(
        con,
        """CREATE OR REPLACE TABLE members AS
           SELECT l.cluster_id, l.score AS link_score, l.rule AS link_rule, s.*
           FROM links l JOIN staged s ON s.source = l.source AND s.source_id = l.source_id""",
    )
    aux = out / "staging" / date / "aux" / "wikidata_qids.parquet"
    if aux.is_file():
        run(con, f"CREATE OR REPLACE VIEW qid_info AS SELECT * FROM read_parquet({sql_str(aux.as_posix())})")
    else:
        run(
            con,
            "CREATE OR REPLACE VIEW qid_info AS SELECT NULL::VARCHAR qid, NULL::INTEGER sitelinks, "
            "NULL::VARCHAR wikipedia_url WHERE false",
        )

    def pick(column: str, field: str, extra_order: str = "") -> str:
        return f"arg_min({column}, {_prec_case(field)}{extra_order}) FILTER (WHERE {column} IS NOT NULL)"

    def pick_source(column: str, field: str, extra_order: str = "") -> str:
        return f"arg_min(source, {_prec_case(field)}{extra_order}) FILTER (WHERE {column} IS NOT NULL)"

    generic = ", ".join(sql_str(c) for c in GENERIC_CATEGORIES)
    category_order = f" + 10 * CASE WHEN category IN ({generic}) THEN 1 ELSE 0 END"
    run(
        con,
        f"""CREATE OR REPLACE TABLE golden_base AS
            SELECT cluster_id AS golden_id,
              any_value(city_code) AS city_code,
              {pick("name", "name")} AS name,
              {pick("name_en", "name_en")} AS name_en,
              {pick("name_local", "name_local")} AS name_local,
              {pick("category", "category", category_order)} AS category,
              {pick("lat", "coords")} AS lat,
              {pick("lon", "coords")} AS lon,
              {pick("address", "address")} AS address,
              {pick("website", "website")} AS website,
              {pick("phone", "phone")} AS phone,
              {pick("opening_hours", "opening_hours")} AS opening_hours,
              {pick("wikidata_qid", "wikidata_qid")} AS wikidata_qid,
              {pick("signals.wikipedia_url", "wikipedia_url")} AS wikipedia_url,
              {pick("signals.description", "description")} AS description,
              {pick_source("signals.description", "description")} AS description_source,
              {pick("signals.description_licence", "description")} AS description_licence,
              max(signals.wikidata_sitelinks) AS member_sitelinks,
              coalesce(bool_or(signals.wikivoyage_listed), false) AS wikivoyage_listed,
              max(signals.confidence) AS confidence,
              count(DISTINCT source) AS n_sources,
              count(*) AS n_records,
              max(link_score) AS best_link_score,
              list_sort(list_distinct(list(source))) AS source_names,
              list_sort(list_distinct(flatten(list(string_split(licence, ' AND '))))) AS licences,
              list_sort(list_distinct(list_filter(list(name), lambda x: x IS NOT NULL)
                        || list_filter(list(name_en), lambda x: x IS NOT NULL)
                        || list_filter(list(name_local), lambda x: x IS NOT NULL))) AS names_all,
              list(struct_pack(source := source, source_id := source_id, licence := licence,
                               raw_ref := raw_ref, fetched_at := fetched_at,
                               link_rule := link_rule) ORDER BY source, source_id) AS sources,
              struct_pack(
                name := {pick_source("name", "name")},
                coordinates := {pick_source("lat", "coords")},
                website := {pick_source("website", "website")},
                opening_hours := {pick_source("opening_hours", "opening_hours")},
                category := {pick_source("category", "category", category_order)}
              ) AS field_sources
            FROM members GROUP BY cluster_id""",
    )
    run(
        con,
        """CREATE OR REPLACE TABLE golden AS
           SELECT g.golden_id, g.city_code, g.name, g.name_en, g.name_local, g.category, g.lat, g.lon,
                  g.address, g.website, g.phone, g.opening_hours, g.wikidata_qid,
                  coalesce(g.wikipedia_url, q.wikipedia_url) AS wikipedia_url,
                  g.description, g.description_source, g.description_licence,
                  greatest(coalesce(g.member_sitelinks, 0), coalesce(q.sitelinks, 0)) AS wikidata_sitelinks,
                  g.wikivoyage_listed, g.confidence, g.n_sources, g.n_records, g.best_link_score,
                  g.source_names, g.licences, g.names_all, g.sources, g.field_sources
           FROM golden_base g LEFT JOIN qid_info q ON q.qid = g.wikidata_qid
           ORDER BY g.city_code, g.golden_id""",
    )


def match_stats(
    con: duckdb.DuckDBPyConnection, per_city: dict[str, dict[str, Any]], cfg: MatchConfig
) -> dict[str, Any]:
    records = int(scalar(con, "SELECT count(*) FROM links"))
    clusters = int(scalar(con, "SELECT count(*) FROM golden"))
    multi_source = int(scalar(con, "SELECT count(*) FROM golden WHERE n_sources > 1"))
    multi_record = int(scalar(con, "SELECT count(*) FROM golden WHERE n_records > 1"))
    by_rule = dict(run(con, "SELECT rule, count(*) FROM links GROUP BY 1 ORDER BY 1"))
    linked = records - by_rule.get("singleton", 0)
    strong = sum(n for r, n in by_rule.items() if r.startswith("strong"))
    sizes = dict(run(con, "SELECT least(n_records, 6) AS size, count(*) FROM golden GROUP BY 1 ORDER BY 1"))
    by_sources = dict(run(con, "SELECT n_sources, count(*) FROM golden GROUP BY 1 ORDER BY 1"))
    by_source = {
        s: {"records": n, "in_multi_source_clusters": m}
        for s, n, m in run(
            con,
            """SELECT l.source, count(*), count(*) FILTER (WHERE g.n_sources > 1)
               FROM links l JOIN golden g ON g.golden_id = l.cluster_id GROUP BY 1 ORDER BY 1""",
        )
    }
    city_counts = {
        c: {"records": r, "clusters": k, "multi_source_clusters": m}
        for c, r, k, m in run(
            con,
            """SELECT l.city_code, sum(n_records), count(*), count(*) FILTER (WHERE n_sources > 1)
               FROM golden l GROUP BY 1 ORDER BY 1""",
        )
    }
    for code, c in city_counts.items():
        c.update(
            {
                k: v
                for k, v in per_city.get(code, {}).items()
                if k in ("candidates", "edges", "refused_by_spread", "seconds")
            }
        )
    return {
        "config": asdict(cfg),
        "records_in": records,
        "clusters_out": clusters,
        "multi_source_clusters": multi_source,
        "multi_source_share": round(multi_source / clusters, 4) if clusters else 0.0,
        "multi_record_clusters": multi_record,
        "records_in_multi_record_clusters": linked,
        "links_by_rule": by_rule,
        "strong_link_share": round(strong / linked, 4) if linked else 0.0,
        "cluster_size_distribution": {("6+" if k >= 6 else str(k)): v for k, v in sizes.items()},
        "clusters_by_source_count": {str(k): v for k, v in by_sources.items()},
        "by_source": by_source,
        "per_city": city_counts,
        "refused_by_spread": sum(c.get("refused_by_spread", 0) for c in per_city.values()),
        "candidate_pairs": sum(c.get("candidates", 0) for c in per_city.values()),
    }


def match(
    out: Path,
    date: str,
    *,
    registry: Registry | None = None,
    cfg: MatchConfig | None = None,
    cities: list[str] | None = None,
    config_dir: Path = CONFIG_DIR,
) -> dict[str, Any]:
    """Run entity resolution on staging/<date>/ and write matched/<date>/{links,golden}.parquet."""
    cfg = cfg or MatchConfig()
    sources = staged_sources(out, date)
    if not sources:
        raise FileNotFoundError(f"No staged data for {date} under {out}; run stage first")
    started = time.monotonic()
    con = open_match_connection(out, date, sources, temp_dir=out / "tmp" / "duckdb")
    load_families(con, config_dir)
    _create_output_tables(con)
    all_cities = [r[0] for r in run(con, "SELECT DISTINCT city_code FROM staged ORDER BY 1")]
    todo = [c for c in all_cities if not cities or c in cities]
    per_city: dict[str, dict[str, Any]] = {}
    for i, city in enumerate(todo, 1):
        per_city[city] = match_city(con, city, cfg)
        log.info("match %s (%d/%d): %s", city, i, len(todo), per_city[city])
    build_golden(con, out, date)
    links_path, golden_path = links_file(out, date), golden_file(out, date)
    links_path.parent.mkdir(parents=True, exist_ok=True)
    run(
        con,
        f"""COPY (SELECT rid AS record_id, source, source_id, city_code, cluster_id, score, rule
                  FROM links ORDER BY city_code, cluster_id, source, source_id)
            TO {sql_str(links_path.as_posix())} (FORMAT parquet, COMPRESSION zstd)""",
    )
    run(con, f"COPY golden TO {sql_str(golden_path.as_posix())} (FORMAT parquet, COMPRESSION zstd)")
    stats = match_stats(con, per_city, cfg)
    stats.update({"run_date": date, "sources": sources, "seconds": round(time.monotonic() - started, 1)})
    write_json(match_stats_file(out, date), stats)
    con.close()
    log.info(
        "match: %s records -> %s clusters (%s multi-source) in %.0fs",
        f"{stats['records_in']:,}",
        f"{stats['clusters_out']:,}",
        f"{stats['multi_source_clusters']:,}",
        stats["seconds"],
    )
    return stats
