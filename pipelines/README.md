# Trippr data pipeline

Python package that turns open place datasets into one clean, checked, deduplicated table of places
for Trippr's 108 cities. PRs 1 and 2 of the [Trip Data Platform Spec](../docs/data-platform-spec.md):
extract and stage **Overture Maps Places**, **Foursquare Open Source Places**, **OpenStreetMap**,
**Wikidata** and **Wikivoyage**, match the same place across sources into golden records, run quality
checks and write a run report. PR 3 adds curation and the bundle (below, and in [docs/data-platform.md](../docs/data-platform.md)); enrichment comes in a later PR.

```
extract ─► raw/<source>/<date>/<CITY>.parquet + _meta.json
stage   ─► staging/<date>/<source>.parquet (staged_place) + <source>.stats.json
match   ─► matched/<date>/links.parquet (record -> cluster) + golden.parquet + match.stats.json
eval-er ─► matched/<date>/eval.json          (precision and recall on eval/er_pairs.csv)
check   ─► reports/<date>.checks.json        (exit 1 on a failed check)
report  ─► reports/<date>.md + <date>.json   (+ $GITHUB_STEP_SUMMARY, + latest.json when passed)
curate  ─► curated/<date>/curated_place.parquet + curate.stats.json   (from matched/<date>/golden.parquet)
bundle  ─► bundles/<date>/{places.jsonl.gz, places.parquet, sources.json, manifest.json}   (exit 1 if a check fails)
           + enrichment.jsonl.gz and enrichment.parquet when enriched/<date>/enrichment.parquet exists (see LLM enrichment)
upload  ─► gs://$DATA_BUCKET/...             (same layout)
```

## Running it locally

Needs Python 3.12 and [uv](https://docs.astral.sh/uv/) (`pip install uv` works too).

```sh
cd pipelines
uv sync                                   # creates .venv from uv.lock
uv run python -m trippr_data extract --source overture --cities TYO,OSA,CKG
uv run python -m trippr_data extract --source osm,wikivoyage,wikidata --cities TYO,OSA   # in this order
uv run python -m trippr_data stage        # defaults to the newest raw date
uv run python -m trippr_data match        # entity resolution: matched/<date>/{links,golden}.parquet
uv run python -m trippr_data eval-er      # precision / recall on the labelled pairs (eval/)
uv run python -m trippr_data check
uv run python -m trippr_data report       # prints the report path
uv run python -m trippr_data curate       # ranks places and picks ~8,000 for the graph (CURATE_BUDGET)
uv run python -m trippr_data bundle       # writes bundles/<date>/ with its checks

uv run python -m trippr_data run --cities all   # all of the above, plus upload when DATA_BUCKET is set

uv run ruff check . && uv run ruff format --check . && uv run pytest   # what CI runs (offline)
```

Every command takes `--date YYYY-MM-DD` (the run folder; extract and run default to today in UTC, the
others to the newest folder) and `--out DIR` (default `pipelines/out/`, which is gitignored).

Extracting reads remote Parquet with DuckDB's `httpfs`, filtered by each city's bounding box, so only
the matching row groups are fetched; nothing is downloaded in full. A full `--cities all` Overture run
took about 37 minutes on a home connection for 6.8 million rows (560 MB of raw Parquet), and staging them about 3 minutes.

### Settings

| Variable | Used by | Meaning |
|---|---|---|
| `DATA_BUCKET` | `run`, `upload`, `check` | Bucket name (no `gs://`). When set, `run` uploads the run and `check` reads the previous run's counts from `reports/latest.json` there. Needs the `gcloud` CLI |
| `CITY_RADIUS_DEFAULT_KM` | all | Radius for big cities (default 25). Smaller kinds use 10 km; per-city overrides are in `config/city_radius.csv` |
| `OVERTURE_RELEASE` | extract | Pin an Overture release instead of the latest from the STAC catalog |
| `HF_TOKEN`, `FSQ_PLACES_PATH`, `FSQ_S3_REGION` | extract | Foursquare token and an optional other location (see below) |
| `OSM_GROUPS` | extract | Comma list of Overpass query groups to fetch (`sights,amenity,shop,food`; default all). The `food` group (restaurants, cafes, bars) is by far the heaviest query |
| `TRIPPR_DATA_OUT` | all | Output root instead of `pipelines/out/` |
| `CURATE_BUDGET` | curate | Total curated places for the graph (default 8000; floor and cap per city in `config/curation.yaml`) |

## Layout

| Path | What |
|---|---|
| `sources.yaml` | Source registry: name, URL, licence, attribution, terms checked on, allowed uses, enabled. A source without an entry (or disabled) is refused |
| `config/taxonomy.csv` | Trippr's 33 place categories, each with one of the app's colour tags (sport, tech, nature, culture, food) or `other` |
| `config/category_map_overture.csv` | Overture taxonomy label → Trippr category (or `exclude`) |
| `config/category_map_foursquare.csv` | Foursquare label path → Trippr category (or `exclude`) |
| `config/category_map_osm.csv` | OSM tags (`tourism=museum`, or `amenity=place_of_worship+religion=shinto`) → Trippr category; the first matching rule in file order wins, and the Overpass query is generated from it |
| `config/category_map_wikidata.csv` | Wikidata instance-of class QIDs → Trippr category; the SPARQL query is generated from it |
| `config/category_map_wikivoyage.csv` | Wikivoyage listing type (see, do, eat, drink, buy, sleep) → Trippr category |
| `config/category_family.csv` | Category families: two places are only compared when their categories share one |
| `config/city_radius.csv` | Per-city radius overrides (small towns and islands at 10 km, Macau at 10 km) |
| `config/curation.yaml`, `config/category_weight.csv` | Curation settings: graph budget, per-city floor and cap, score weights, category weights and shares, colour-tag mix |
| `config/countries.csv` | Country bounding boxes (for the coordinate check) and local languages (for `name_local`) |
| `src/trippr_data/` | `extract/` (one module per source), `stage.py`, `match.py`, `similarity.py`, `eval_er.py`, `checks.py`, `report.py`, `storage.py`, `cli.py` |
| `eval/` | The hand-labelled pairs for entity resolution and how they were labelled (`eval/README.md`) |
| `tests/` | pytest; `tests/fixtures/` holds the two-city fixtures and the golden output |

Cities come from `../seed/cities.json` (not modified). Each city's area is a circle of its radius; the
extract uses the circle's bounding box and staging keeps a place only if it is within the radius of its
nearest city. When a place's address names a country, cities in that country are preferred, so a
Shenzhen shop does not land in Hong Kong and a Zhuhai shop is not counted as Macau.

## staged_place

| Field | Notes |
|---|---|
| `source`, `source_id` | `overture` + GERS id, `foursquare` + `fsq_place_id`, `osm` + `node/123`, `wikidata` + QID, `wikivoyage` + `<page id>:<hash of type, name, coordinates>` |
| `name`, `name_local`, `name_en` | `name` is the source's primary name after NFKC normalisation (full-width Latin → ASCII, half-width katakana → full-width, whitespace collapsed, separator punctuation trimmed). Scripts are kept: `name_local` is the name in one of the country's languages (Overture name rules) or the primary name when it is not Latin script; `name_en` is the English name rule or the primary name when it is Latin script |
| `category_source`, `category` | The source's own category and Trippr's |
| `lat`, `lon`, `city_code` | WGS84; the nearest Trippr city within its radius |
| `address`, `website`, `phone`, `opening_hours` | When the source has them (opening hours come from OSM and Wikivoyage) |
| `wikidata_qid` | OSM's `wikidata` tag, a Wikivoyage listing's `wikidata`, or the Wikidata item itself. Overture and Foursquare places have none (Overture only has a brand QID, kept in `signals.brand_wikidata`) |
| `signals` | `confidence` (Overture), `providers` (Overture's upstream datasets), `brand_wikidata`; `wikidata_sitelinks` (Wikidata items), `wikivoyage_listed` (true for Wikivoyage listings); `description` with `description_licence` (Wikivoyage's `content`, flagged `CC-BY-SA-4.0`, or a Wikidata description, `CC0-1.0`) and `wikipedia_url` |
| `licence`, `fetched_at`, `raw_ref` | Per-record licence (Overture's `sources[].license`, `ODbL-1.0` for OSM, `CC0-1.0` for Wikidata, `CC-BY-SA-4.0` for Wikivoyage), fetch time and the raw file it came from |

Staging also drops duplicate source ids, permanently closed places, places outside every city's
radius, places whose country does not match, and places without a name. Each step's count is in
`<source>.stats.json` and the report.

### Categories

A place takes the rule for its most specific category: for Overture its `taxonomy.primary`, then each
ancestor in `taxonomy.hierarchy`; for Foursquare the longest matching prefix of its first label.
`exclude` drops it on purpose (offices, clinics, hotels, most shops); a place with no rule is
**unmapped**, also dropped, and the report shows the unmapped share and the most common unmapped
categories so the CSVs can be improved in review. In the first full run (Overture 2026-11-18.0, all
108 cities) the unmapped share was 7.0%, almost all places with no Overture category at all or only a
top-level one (`shopping`, `food_and_drink`, ...). Overture has no viewpoint category, so `viewpoint`
stays empty until OpenStreetMap arrives in PR 2.

## Checks

| Check | Fails when |
|---|---|
| `schema` | The staged columns or types differ from `staged_place` |
| `row_counts.vs_previous` | A source/city count moved more than ±40% from the last passed run (the first run just records). Counts under 100 in both runs only warn |
| `null_rates.required` | Any null in source, source_id, name, category, lat, lon, city_code, licence, fetched_at or raw_ref (optional fields are reported) |
| `coordinates.city_radius` | A place is outside its city's radius |
| `coordinates.country_bbox` | More than 0.1% of places are outside their country's bounding box |
| `licence.present`, `licence.registered` | A place has no licence, or one not listed for its source in `sources.yaml` |
| `duplicates.source_id` | A source id appears twice |
| `categories.in_taxonomy` | A category is not in `taxonomy.csv` |
| `match.cluster_spread` | A cluster is wider than 500 m |
| `match.links` | A link points at a record that does not exist, a record has no link or two, or a link has no golden record |
| `match.golden_licences` | A golden record has no licence list, its `sources[]` do not match its record count, or a licence is not in `sources.yaml` |
| `match.duplicate_golden` | More than 0.5% of golden records have another within 50 m with the same name (warns on any) |
| `match.eval` | Precision on the labelled pairs is under 95% (fails) or recall under 85% (warns) |

## Sources

### Overture Maps Places (enabled)

- Data: `s3://overturemaps-us-west-2/release/<release>/theme=places/type=place/*` (public, anonymous).
  The release is the `latest` entry of the STAC catalog `https://stac.overturemaps.org/catalog.json`.
- Schema v2 fields used: `id`, `names` (`primary`, `rules` for language variants), `taxonomy`
  (`primary`, `hierarchy`), `basic_category` (fallback), `confidence`, `websites`, `phones`,
  `addresses` (`freeform`, `locality`, `postcode`, `country`), `sources` (`dataset`, `license`,
  `record_id`), `operating_status`, `brand.wikidata`, `bbox`. The old `categories` field was removed
  in the September 2026 release.
- Licence: per provider, CDLA Permissive 2.0, Apache 2.0 (Foursquare) or CC0 1.0 (AllThePlaces).
  Attribution: "© Overture Maps Foundation, overturemaps.org" plus the Foursquare copyright line.

### Foursquare Open Source Places

Apache 2.0, read from the gated Hugging Face dataset
[foursquare/fsq-os-places](https://huggingface.co/datasets/foursquare/fsq-os-places). The owner's
Hugging Face account has accepted the dataset's conditions. The pipeline reads the newest release it was
checked against (`dt=2026-11-17`) unless `FSQ_PLACES_PATH` points somewhere else, and only the rows
inside each city's box (the full release is about 11.6 GB).

A Hugging Face token is needed, found in this order:

1. `HF_TOKEN` in the environment (the workflow uses the repository secret of the same name).
2. The login cached by the Hugging Face CLI: run `hf auth login` once and paste a **read** token when it
   asks (the input is hidden). DuckDB reads it through its credential chain, so the token never passes
   through the pipeline's code or logs.

Without a token, a scheduled run skips Foursquare with a warning and carries on with Overture; asking
for it by name (`--source foursquare`) fails instead.

`config/category_map_foursquare.csv` was written from Foursquare's published taxonomy; check the
unmapped categories in the report after the first real run.

### OpenStreetMap (enabled)

- Access: the **Overpass API**, one query per city per group (`sights`, `amenity`, `shop`, `food`) over the
  city's bounding box, generated from `config/category_map_osm.csv`, only features with a `name`, with
  `out center` so ways and relations get a point. Responses are cached as `<CITY>.<group>.overpass.json.gz`
  next to the raw Parquet, so re-running never queries again.
- Why Overpass and not Geofabrik: 108 circles of 10 to 25 km are a few hundred MB of tagged features, while
  the country extracts that cover them (Japan, China, Indonesia, ...) are over 10 GB and need a PBF reader and
  a node-location index to cut out. Overpass is the right size for a monthly run. In practice the public
  server is often at capacity (502/504); the extractor waits for a free slot (`/api/status`), sends one query
  at a time at least 10 s apart with a User-Agent that names the app, retries with backoff, falls back to
  `overpass.private.coffee`, keeps finished groups cached and exits non-zero (`OverpassIncompleteError`)
  naming what is missing, so running the same command again completes the rest. If the pipeline ever runs
  weekly, switch to Geofabrik extracts (nothing else changes: raw rows are `osm_type, osm_id, lat, lon, tags`).
- Staging: `name`, `name:en` and `name:<local language>` become the name variants; `wikidata` the QID;
  `opening_hours`, `website` and `phone` are copied; the category is the first rule of the CSV the tags
  satisfy (so `tourism=museum` beats `historic=building`).

### Wikidata (enabled)

- Access: the SPARQL endpoint, politely (one query at a time, at least 6 s apart, `Retry-After` honoured, 60 s
  query limit). Per city, one `wikibase:around` query for items inside the circle whose **direct** instance-of
  class is in `config/category_map_wikidata.csv` and that have at least one sitelink, then batched `VALUES`
  queries (150 QIDs) for labels (English and the country's languages), description, website, English
  Wikipedia link, coordinates and sitelink count. Subclass paths (`P31/P279*`) were tried and took 55 s for
  Kyoto against 3 s, so the CSV lists specific classes instead.
- QIDs that OSM and Wikivoyage name in the same city are fetched too (`via = linked`) even when their class is
  not in the CSV, so the matched place can carry the sitelink count. Run `extract` for Wikidata after OSM and
  Wikivoyage (the CLI orders sources that way).

### Wikivoyage (enabled)

- Access: the English Wikivoyage monthly dump (`enwikivoyage-latest-pages-articles.xml.bz2`, about 130 MB),
  downloaded once into `<out>/downloads/wikivoyage/<dump date>/`, checked against the published sha1, and
  parsed locally with the standard library (no scraping). `{{see}}`, `{{do}}`, `{{eat}}`, `{{drink}}`,
  `{{sleep}}`, `{{buy}}` and `{{listing|type=...}}` are read, with name, alt, url, address, lat, long, phone,
  hours, wikidata, wikipedia, lastedit and content; links, refs and templates are stripped from the text.
- A listing goes to every city whose bounding box holds its coordinates (staging keeps the nearest city inside
  its radius). Listings without coordinates inside an article named for a Trippr city (`Tokyo`, `Tokyo/Shibuya`)
  are kept in that city's raw file with empty coordinates and counted, but cannot be staged: nothing places
  them. `sleep` listings are excluded (hotels come in a later PR).
- `content` is CC BY-SA 4.0 text: it stays in `signals.description` with `description_licence =
  CC-BY-SA-4.0`, and a golden record that uses it says so.

## Entity resolution

`match` (also run by `run`) reads every staged source and writes `matched/<date>/links.parquet` (source
record -> cluster id, score, rule), `golden.parquet` (one record per cluster, with `sources[]`, `licences`,
`field_sources` and the Wikivoyage text flagged by licence) and `match.stats.json`. Per city:

1. **Blocking**: different sources, same or neighbouring geohash-7 cells (360/2^18 degrees, about 150 m; so
   pairs more than roughly 150 to 300 m apart are never compared), within 500 m, categories sharing a family
   (`config/category_family.csv`).
2. **Strong links** (score 1): a shared Wikidata QID, or a shared website host (first path segment on shared
   hosts like facebook.com) within 300 m and some name similarity. A QID or website used by four or more
   places of one source (a chain) is not a strong link.
3. **Scored pairs**: `0.55 name + 0.30 distance + 0.15 category + 0.15 phone-or-address bonus`, capped at 1.
   Name similarity is the best over every `name` / `name_en` / `name_local` variant pair of the larger of
   Jaro-Winkler (rescaled so 0.7 and below count as 0) and a token-set measure weighted by token length and rarity in the city (so shared place or branch words count little); Han, kana,
   Hangul and Thai text is compared as character bigrams (no word-splitting assumed) and different scripts are
   only compared through the variants they share. Distance is 1 under 75 m falling to 0 at 500 m (30 m to
   150 m for chain names). A pair needs name similarity of 0.6 (or a matching phone) and a score of 0.82.
   The weights are hand-set in `MatchConfig`; the eval below checks them.
4. **Pruning**: a pair is kept when each record is within 0.12 of the other's best partner in its source
   (so near-duplicate listings of one place both join), or its score is 0.92 or more.
5. **Clustering**: union-find, strong links first; a merge that would make the cluster wider than 500 m is
   refused.
6. **Survivorship** (first available wins): names from Wikidata, then Wikivoyage, OSM, Overture, Foursquare;
   coordinates from OSM, then Overture; websites from Overture, then Wikidata; opening hours from OSM, then
   Wikivoyage; descriptions from Wikivoyage, then Wikidata; category from OSM, Wikidata, Overture, then the
   generic Wikivoyage one. The sitelink count is the maximum over the cluster and the Wikidata item.

### Evaluation

`eval/er_pairs.csv` has 408 candidate pairs in six cities (Kyoto, Shanghai, Busan, Hanoi, Chiang Mai,
Taichung), **labelled by the pipeline's author (an AI assistant) and in need of human review**; see
`eval/README.md`. `eval-er` re-runs the matcher for those cities and reports precision and recall of "same
cluster" at the chosen threshold plus a sweep, writes `matched/<date>/eval.json`, and the run report and the
`match.eval` check show it (precision under 95% fails the run, recall under 85% warns).

### First full run (2026-11-22, all 108 cities)

| Source | Raw rows | Staged | Notes |
|---|---:|---:|---|
| Overture 2026-11-18.0 | 6,821,810 | 2,276,026 | from PR 1 |
| Foursquare dt=2026-11-17 | 13,560,332 | 3,729,418 | from PR 1 |
| OpenStreetMap | 78,096 | 66,104 | **Tokyo and Guangzhou only** (see below) |
| Wikidata (wdqs-2026-11-22) | 25,978 | 22,448 | 108 cities, 6.6% of rows in no mapped class |
| Wikivoyage (dump 2026-11-01) | 20,660 | 10,867 | 108 cities; 443,714 listings in the dump |

`match`: 6,104,863 records became 5,229,009 places (14.6% confirmed by more than one source, 34,037 by three
or more; 92,196 places include an OSM, Wikidata or Wikivoyage record and 39,172 exist only there), in 111
minutes on a laptop (Tokyo alone took 40, with 93 million candidate pairs). Evaluation on the 383 labelled
pairs at threshold 0.82: precision 95.1%, recall 85.0%. The threshold was chosen on these same pairs
(the 0.78 starting point gave 94.1% and 90.0%), so the numbers are optimistic until the labels are reviewed
and a held-out set exists. Extraction took about 9 minutes for Wikivoyage (after a 30 s download), about
95 minutes for Wikidata (public endpoint, with retries) and, for OpenStreetMap, far longer than that for
almost nothing: **the public Overpass servers were at capacity (502/504) for most of the run**, so only
Tokyo and Guangzhou completed in full. Re-run `extract --source osm --cities all` (finished groups are
cached; `OSM_GROUPS=sights,amenity,shop` fetches the light queries first) when Overpass is quieter, or
switch to Geofabrik extracts, then `stage`, `match` and `eval-er`; nothing else needs to change.

## Embeddings and search eval

`embed` turns places into vectors for semantic search ([spike and recommendation](../docs/embeddings-spike.md)).
It is not part of `run`: it reads the curated bundle and is run on a laptop (see the spike for why).

```sh
uv sync --extra embed                       # onnxruntime + tokenizers + huggingface-hub (no PyTorch)
uv run python -m trippr_data embed [--input path/to/places.parquet] [--model bge-m3-q8]
uv run python -m trippr_data eval-search    # recall@k, MRR, NDCG@10 on the labelled queries
```

- Input columns are mapped in one file, `src/trippr_data/embed/inputs.py` (`FIELD_COLUMNS`, `ID_COLUMNS`),
  and default to `out/bundles/<date>/places.parquet` (the newest bundle). Staged Parquet, other Parquet and CSV work as they are.
- The text per place is "names (every script) · category · city · summary · description"
  (`embed/text.py`; bump `TEXT_VERSION` when the template changes).
- Output: `out/embeddings/<date>/embeddings.parquet` (`place_id`, `content_hash`, `vector`) and
  `manifest.json` (model, exact weights version, dims, text version, counts, checksum). Vectors are unit
  length, so cosine similarity is a dot product.
- Cache: `out/cache/embeddings/<model>.parquet`, keyed by a hash of the model, its version, the text
  version and the text, so only new or changed places are embedded.
- `eval-search` uses `eval/search/` (a 2,263-place corpus drawn from the staged Overture and Foursquare
  data and 68 labelled queries in English, Japanese, Chinese, Korean, Vietnamese and Thai) and
  brute-force cosine; it writes `reports/<date>.search-eval.json` and takes `--min-mrr` and
  `--min-recall10` thresholds. For the real bundle use `--corpus out/bundles/<date>/places.parquet
  --queries eval/search/queries_bundle.yaml` (89 queries with rule-based labels). `model_spike.py` is
  the spike's measuring script and `parity_check.py` checks that a hosted endpoint serves the same model.
- The enrich stage's AI `summary` is added to a place's text from the newest
  `out/enriched/<date>/enrichment.parquet` (`--enriched FILE` to choose, `--no-enriched` to skip).
- Default model: `bge-m3-q8` (8-bit BGE-M3, 1024 dims, about 24 minutes for 8,000 places on 4 CPU
  threads; first use downloads 570 MB). The query side must use the same model (see the spike).
- Tests use a fake hashing embedder; CI installs no model dependency and downloads nothing.

## Stay analytics

PR 7 of the spec (Feature 5): open-data hotels, Inside Airbnb market data and per-area stay scores. This is
the pipeline half; the graph (Area aggregates), the map heat layer, Area cards and the API come after the
bundle carries these tables.

```sh
uv run python -m trippr_data stay-extract --cities all         # Inside Airbnb + Bank of Canada rates (covered cities only)
uv run python -m trippr_data stay --places <places.parquet>    # stage hotels + listings, analyse, check, report
# or step by step: stay-stage, stay-analyse, stay-check, stay-report
```

| Stage | What | Output |
|---|---|---|
| `stay-extract` | Newest snapshot of each covered city from Inside Airbnb (`listings.csv.gz`, `calendar.csv.gz`, `reviews.csv`, neighbourhoods and polygons), then the Bank of Canada rates the snapshots need. `--source osm_lodging` also reads OSM `tourism=hotel\|hostel\|guest_house\|apartment\|motel` from Overpass | `raw/insideairbnb/<date>/<CITY>/*`, `raw/boc_fx/<date>/rates.json`, `raw/osm_lodging/<date>/<CITY>.json`, each with `_meta.json` (licence, attribution, URL, bytes, sha256) |
| `stay-stage` | Hotels: lodging rows of the Overture and Foursquare raw files (and OSM lodging when extracted), mapped to a kind by `config/lodging_kinds.csv`, merged within and across sources. Listings: cleaned, converted to CAD, flagged | `staging/<date>/stay/hotel.parquet`, `hotel_source.parquet`, `airbnb_listing.parquet`, `airbnb_calendar.parquet`, `airbnb_reviews_monthly.parquet`, `airbnb_neighbourhood.parquet` |
| `stay-analyse` | DuckDB aggregates per unit and the scores | `curated/<date>/stay/stay_unit.parquet`, `stay_summary.json` |
| `stay-check` | `stay.*` checks (below); exits 1 on a failure | `reports/<date>.stay.checks.json` |
| `stay-report` | The stay section, also appended to the main report when it exists | `reports/<date>.stay.md` |

**Inside Airbnb coverage of Trippr's 108 cities** (checked 2026-11-23 against insideairbnb.com/get-the-data):
Tokyo, Hong Kong, Singapore, Taipei and Bangkok. No other dataset exists in Trippr's 19 countries (not Osaka,
Kyoto, Seoul, Bali or Hanoi, for example); `stay-extract` warns when the index adds one. Every other city has
no market layer, only open-data hotels and place-based scores. The city to dataset map and currencies are in
`config/insideairbnb_cities.csv`.

**Licences and manners.** Inside Airbnb is CC BY 4.0; its Data Policies ask for attribution, not to scrape the
site, to download once rather than on every run and not to republish the data. So the downloader reads the
index page once, fetches one file at a time with a pause, identifies itself with a generic User-Agent, obeys
`robots.txt`, never refetches a snapshot whose checksum matches, keeps raw and staged listings private and
publishes aggregates only (units under 3 listings are emptied; no listing ids, host ids, names or links leave
`staging/`). Nothing is taken from Airbnb, Booking or Google. Exchange rates come from the Bank of Canada
Valet API (attribution required). OSM lodging is ODbL: derived tables stay private like the other OSM-derived
fields.

**Units.** One `stay_unit` table: `city` (the reference for comparisons), `area` (a Trippr Area from
`seed/areas.json`; listings and hotels within its radius, `radiusKm` or 1.5 km), `neighbourhood` (Inside
Airbnb's) and `h3` (resolution 8 cells with at least 3 listings, for the heat layer).

**Listings cleaning.** `$1,338.49` is parsed, quoted in the city's local currency, converted at the Bank of
Canada rate on or before the snapshot date. `price_status` is `missing`, `below_floor` (under CAD 10),
`above_p99` (the city's 99th percentile) or `ok`; only `ok` prices with a minimum stay of 28 nights or less
count in price statistics (`stats_ok`). Room types become `entire_home`, `private_room`, `shared_room`,
`hotel_room`.

**Aggregates** (per unit): median nightly price in CAD (all, entire home, private room, per person),
quartiles, share of entire homes and private rooms, median rating and listings with 10 or more reviews,
reviews in the last 12 months, share of the next year unavailable (calendar: booked or blocked), median
availability, Inside Airbnb's estimated occupancy, listing density per km2, licensed share, multi-listing
host share (hosts with 3 or more listings) and the share held by the top 5 hosts, hotels from open data and
places nearby.

**The stay score** (`config/stay_score.yaml`, `src/trippr_data/stay/scoring.py`, pinned by
`tests/test_stay_scoring.py`). Four parts, each 0 to 100, higher is better, weighted 40/30/20/10:

| Part | Formula |
|---|---|
| `value` (40%) | Share of the city's bookable listings whose price per person-night is higher than the unit's median (ties count half): 70 means "cheaper than 70% of Tokyo's listings". Needs 10 priced listings |
| `walkability` (30%) | A proxy: places within 600 m of the unit centre (matched golden places by default; `--places` takes a bundle's `places.parquet`), `100 x min(1, ln(1+n) / ln(1+120))` |
| `quiet` (20%) | A proxy: `100 - 100 x min(1, ln(1+n) / ln(1+12))` for bars and nightlife venues within 300 m |
| `reviews` (10%) | The unit's median rating shrunk toward the city's by 10 extra rated listings, mapped from 4.0..5.0 to 0..100. Needs 10 rated listings |

The score is the weighted mean of the parts a unit has, weights rescaled to them, and only when they carry at
least half the weight (so a city with no Inside Airbnb data still gets walkability and quiet). The row keeps
every part, `score_parts`, `weight_coverage` and an `explanation` sentence for the Area card. Units centred
outside their city's radius have no place data and are not scored on places.

**Hotels.** Overture and Foursquare lodging come from the raw files the places extract already writes
(nothing extra to download). Closed places, camping sites and unnamed rows are dropped; the same hotel in
several sources, or twice in one source, is merged (cross-source within 100 m and 0.85 name similarity,
same-source within 50 m and 0.95; field precedence OSM, Overture, Foursquare; clusters wider than 200 m are
not merged). Each hotel keeps its `sources[]`, licences, the Area it falls in and the distance to its centre.
The kind `other` counts lodging with no more specific category.

**Checks** (`stay.*`): schema, required fields, unique ids, coordinates inside the city radius and country
box, licences listed in `sources.yaml`, no same-name hotels within 50 m, price coverage and sanity per city,
exchange rate present and not after the snapshot, snapshot age, neighbourhood names, calendar coverage,
reviews summary against `reviews_ltm`, raw file checksums, scores within 0..100, shares within 0..1, the
privacy minimum, every score explained, and counts within 40% of the previous stay run.

**Tests.** Offline: `tests/test_stay_*.py` use fixtures in `tests/fixtures/stay/` (built by
`tests/fixtures/make_stay_fixtures.py`: real Overture lodging rows plus synthetic Foursquare, OSM and Inside
Airbnb-shaped data) and a local HTTP server for the extractors, and compare hotels, unit scores, summary and the
report section with `tests/fixtures/expected/stay/` (`UPDATE_GOLDEN=1` regenerates them).

Limits worth knowing: the Inside Airbnb calendar has no prices (nightly price is the listing's own), prices are
asking prices, "unavailable" is booked or blocked by the host, the places proxies count source records inside a
radius, and no centrality part is in the score yet (the card shows distance to the city centre and to the
nearest hub station from `seed/hubs.json`).

## Scheduled runs

`.github/workflows/data-pipeline.yml` runs monthly (and on demand) once the `DATA_BUCKET` repository
variable exists. It signs in to Google Cloud with workload identity federation (the same
`GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT` as `deploy.yml`), runs
`run --cities all`, uploads to the bucket and puts the report in the run summary. A failed check
fails the workflow; the data is still uploaded for inspection, but `reports/latest.json` (the next
run's baseline) only moves on a passed run.

The owner has created the bucket `trippr-bucket-data` (private, US) and set `DATA_BUCKET=trippr-bucket-data`.
For reference, a setup like it (nothing here is created by the code):

```sh
gcloud storage buckets create gs://trippr-bucket-data --project "$GCP_PROJECT_ID" --location us-central1 \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding gs://trippr-bucket-data \
  --member "serviceAccount:$GCP_SERVICE_ACCOUNT" --role roles/storage.objectAdmin
```

Then add the repository variable `DATA_BUCKET=trippr-bucket-data`.

## LLM enrichment (PR 4)

`enrich` adds `tags`, a one-line `summary`, `duration_min`, `best_time`, `indoor`, `price_level`,
`good_for` and a `display_name` / `is_generic_name` suggestion to each curated place with Claude's **Message Batches API** (half price). It does not run in the
scheduled workflow yet: it reads the curate stage's `curated_place.parquet` (or a bundle's
`places.parquet` / `places.jsonl.gz`).

```sh
export ANTHROPIC_API_KEY=...        # read from the environment only; never stored in a file

# 1. Cost first. Counts tokens on a sample of the real requests (free) and prints the estimate.
uv run python -m trippr_data enrich --dry-run                       # newest out/curated/<date>/curated_place.parquet
# no key yet? --dry-run --offline estimates from character counts, no API call
# 2. Spend, only with --yes and only under the cap
uv run python -m trippr_data enrich --yes
```

| | |
|---|---|
| Input | Parquet or JSON lines. Columns are named in one place, `enrich/inputs.py`: `place_id`, `name`, `name_local`, `name_en`, `category`, `city_code`, `address`, `opening_hours`, `description` (the golden record's one description), `sources` (names, or records with a `source` field). `place_id` falls back to `id` (bundle), `golden_id`, then `source:source_id` (staged). `--column-map ours=theirs ...` handles any rename. The default path, the newest `out/curated/<date>/curated_place.parquet`, is also set there |
| Output | `out/enriched/<date>/enrichment.parquet`: the fields above, `content_hash`, `display_name` and `is_generic_name` (suggestions only, nothing is renamed: see below), `ai` (true), `ai_label` ("Summary written by AI from Wikivoyage and OpenStreetMap") and a `provenance` struct (`summary_ai`, `model`, `prompt_version`, `enriched_at`, `batch_id`, `input_sources`) |
| Model | `--model haiku` (`claude-haiku-5-5`, default) or `sonnet` (`claude-sonnet-5-5`), or `ENRICH_MODEL`. Choose with `eval-enrich --models haiku,sonnet`; the spec's rule is the small model unless it misses the targets |
| Request | Strict JSON schema in `output_config.format`, `effort: low`, no sampling parameters and no thinking budget (current models reject both), a one-hour prompt cache on the shared system prompt. Place text goes in the user turn as data |
| Cache | `out/enrich/enrich.cache.jsonl`, keyed by sha256(kind, model, prompt version, content hash) of exactly the fields the model sees. Unchanged places are never sent again; editing a place, the model or `PROMPT_VERSION` (`enrich/prompt.py`) re-enriches just those |
| Resume | Each batch is recorded in `out/enrich/enrich.state.json` the moment it is created. `--no-wait` submits and returns; rerunning the same command (or `enrich-status --collect`) collects finished batches and never resubmits a key already in flight. A key that fails validation three times is left out until its input changes |
| Cost guard | The estimate must be within `ENRICH_BUDGET_USD` (default **25** for the first full run, or `--budget-usd`) or nothing is submitted (exit 3). `--yes` is required to spend at all (exit 3 without it). The cap is re-checked before each batch of `--batch-size` (2000). Output tokens are an assumption (350 each, `--output-tokens`); `eval-enrich` prints the measured average to calibrate it |
| Guardrails | Output is pydantic-validated: tags must be taxonomy categories, at most 4; summary at most 140 characters (code points, so CJK gets the same room), one line, URLs dropped, no replacement characters; duration 5 to 1440 minutes |

### In the bundle

`bundle` picks up `out/enriched/<date>/enrichment.parquet` (the bundle's date, else the newest earlier date,
since enrichment is cached across runs) and writes it next to the places, joined by id (`place_id` is the
bundle's `id`):

| File | What |
|---|---|
| `enrichment.jsonl.gz` | One enriched place per line, in the order of `places.jsonl.gz`: `id`, `tags`, `summary`, `duration_min`, `best_time`, `indoor`, `price_level`, `good_for`, `display_name`, `is_generic_name`, `ai`, `ai_label` and `provenance` (`summary_ai`, `model`, `prompt_version`, `enriched_at`, `batch_id`, `input_sources`). Places that were not enriched have no line. Places the bundle no longer contains are dropped |
| `enrichment.parquet` | The same rows for DuckDB and BigQuery (with the places Parquet) |
| `manifest.json` | `enrichment`: places, places with a summary, models, prompt versions, newest `enriched_at` and the `enriched/<date>` it came from. `evals.enrich`: the scores in `out/enrich-eval/<model>/report.json` for the model that enriched the most places, when `eval-enrich` has been run for it |

`places.jsonl.gz` is unchanged, so a bundle without enrichment is still valid and everything that reads places
(embed, the load job) keeps working. The bundle check `enrichment.summary_provenance` fails the bundle (so the
app never loads it) when any place has a summary without `ai`, an AI label and `provenance.summary_ai`, or
claims an AI summary it does not have. The tests build the committed golden bundle with a fake answer cache
and made-up eval scores (`tests/enrichment_fixture.py`), so no model is called.

### Names and cost

`display_name` / `is_generic_name` are written for curation to use later; enrichment never changes a name.
`is_generic_name` is true for a record whose name is not a place name: only a city or country ("Tokyo,
Japan"), only a type ("City Park"), an operator or legal entity ("Independent Administrative Institution
National Museum", Tokyo's second place in the bundle), or an address. `display_name` is then the name with the
formal part removed, or the common name when the description, address, category and city identify it
("Tokyo National Museum"), else null. The summary of a generic-named place says only what category and city
support. `eval-enrich` scores generic-name recall and precision and display-name matches on the 12 labelled
cases, and rule-checks every display name against the input.

Estimate for the full curated set (character heuristic; run `enrich --dry-run` with a key for exact counts).
Each request is about 1,900 tokens (the shared prompt and schema are about 1,800 of them, cacheable) plus
250 to 600 output tokens (assumed):

| Model | 8,000 places | 40,000 places (5x) | Fits the $25 cap |
|---|---|---|---|
| `claude-haiku-5-5` (default) | $1.3 to $2.2 (about $1.5 expected) | $6.4 to $10.9 (about $7.4) | yes, both |
| `claude-sonnet-5-5` | $25 to $43 (about $30) | $127 to $217 (about $148) | no |

Prices are batch rates (50% off) cached 2026-11-03 in `enrich/pricing.py`; with the shared prompt served from
the cache the Haiku figures drop by about 45%. Worst case, every answer running to the 1,024-token cap, is
$2.8 to $3.0 for 8,000 Haiku places.

### Eval

`eval-enrich` runs a model over `eval/enrich_places.jsonl` (174 hand-labelled places in 17 countries and 9
scripts, 12 of them formal or city-named records; see `eval/ENRICH.md`) and scores tag precision, recall and F1, duration within ±30 minutes,
best-time and indoor accuracy, and summary faithfulness (rule checks for numbers, proper nouns and
non-Latin names that are not in the input; `--judge` adds a second cheap-model rubric check). Targets from
the spec: tag F1 0.85, at most 2% unsupported summaries. It prints per-script and per-country tables, the
places worth reading and the cost per 1,000 places, and exits 1 if no model meets the targets.

```sh
uv run python -m trippr_data eval-enrich --dry-run --offline --extrapolate-to 8000   # estimate only
uv run python -m trippr_data eval-enrich --models haiku,sonnet --judge --yes          # cents to about a dollar
```

Tests (`tests/enrich/`) use a fake client that implements the Batch API surface. They never touch the
network, and a guard fails any test that constructs a real `anthropic.Anthropic`.
