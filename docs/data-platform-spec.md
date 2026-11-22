# Trip Data Platform Spec

Nov 22, 2026 · Trippr (Asia 2027) · feature spec, ready to build

## Overview

Trippr's places are hand-written today: 11 stops, 108 cities, a few hundred activities. This spec turns Trippr into a data and AI engineering project:

- **Thousands of real activities**, merged from four open datasets, matched across sources, enriched by an LLM, and searchable by meaning.
- **Where to stay, backed by data**: open hotel listings plus Inside Airbnb market data, summarised into scores for each area.
- **Real flight prices over time**: daily snapshots between the trip's stops, with trend charts and a simple "book now or wait" signal.

Everything comes from open data or official APIs. **Nothing is scraped.** Google Flights and Airbnb both forbid scraping in their terms and have no public API, so Google Flights stays as the deep links already in the app, and Airbnb is covered by the Inside Airbnb public datasets.

| # | Feature | In one line |
|---|---|---|
| 1 | **Data pipeline** | Raw data in Cloud Storage, cleaned and joined with DuckDB and Parquet, loaded into the graph by a scheduled job, with quality checks and provenance on every record |
| 2 | **Activity catalogue** | Overture, Foursquare, OpenStreetMap, Wikidata and Wikivoyage combined into one deduplicated set of places for the trip's cities |
| 3 | **LLM enrichment** | Claude's batch API adds tags, a one-line summary, typical duration and best time of day to each activity, checked against a labelled eval set |
| 4 | **Semantic search and recommendations** | Embeddings and a vector index answer "quiet viewpoints at sunset near our Osaka hotel", and the group's votes drive suggestions |
| 5 | **Stay analytics** | Hotels from open data plus Inside Airbnb prices and reviews, summarised by neighbourhood into scores for each Area |
| 6 | **Flight prices** | Daily price snapshots for the route's flights, stored as a time series, with charts and a booking signal |
| 7 | **Data page** | Sources, licences, counts, freshness and quality results, visible in the app and in each pipeline run |

Users are the same group: Brady (owner) and 4 to 5 friends (editors and viewers), mostly on phones. A second audience is anyone reviewing the repo as a data and AI engineering portfolio piece.

## Goals

- Grow the activity library from hundreds to thousands of real places, each traceable to its sources and licence.
- Show a real data pipeline end to end: extract, stage, match, enrich, embed, load, check, schedule.
- Measure the AI parts: entity matching precision and recall, enrichment accuracy, search relevance.
- Help the group decide where to stay with numbers (price per night, review quality, how busy an area is) rather than opinions.
- Help the group decide when to book flights from real price history.
- Keep it cheap: no new always-on servers, and every paid step costed before it runs.

**Not in this version:** booking anything inside Trippr; showing or storing individual Airbnb listings beyond what Inside Airbnb publishes; scraping any website; live rail prices (China Rail, SmartEX and Korail have no public APIs; their links stay).

## Data sources

All licences and coverage below must be confirmed when each source is added, and recorded in the source registry (see "Provenance and licences").

| Source | What we take | Access | Licence (confirm) | Refresh |
|---|---|---|---|---|
| **Overture Maps Places** | Name, category, coordinates, address, website, confidence, source references | GeoParquet on public cloud storage, read with DuckDB using a bounding box for each city (no full download) | CDLA Permissive 2.0 | Monthly releases |
| **Foursquare Open Source Places** | Name, category, coordinates, address, website | Parquet files, read with DuckDB | Apache 2.0 | As released |
| **OpenStreetMap** | Tourism, leisure, historic and amenity features, opening hours, `wikidata` tags | Overpass API, one query per city with polite rate limits, or a Geofabrik regional extract | ODbL (share-alike for the database; attribution required) | Monthly |
| **Wikidata** | Notability (how many Wikipedia sitelinks), descriptions, Wikipedia links, official websites | SPARQL by QID, batched | CC0 | Monthly |
| **Wikivoyage** | "See", "Do", "Eat", "Drink" and "Sleep" listings with short descriptions | Monthly XML dumps, parsed from listing templates | CC BY-SA 4.0 (attribution, share-alike for text) | Monthly |
| **Inside Airbnb** | Listings (neighbourhood, room type, price, reviews, coordinates) and calendars | CSV snapshots for each covered city | CC BY 4.0 | Quarterly snapshots |
| **Hotel prices** (one provider, chosen in a spike) | Nightly rates for the stop's dates and group size | LiteAPI, Hotelbeds or the Booking.com affiliate API: whichever offers a free sandbox and acceptable terms | Provider terms | On demand, cached 6 hours |
| **Flight prices** (chosen in a spike) | Prices for origin, destination and date | Travelpayouts Data API (real prices, cached from searches) first; Duffel later if bookable offers are wanted (its test mode returns sandbox airlines, not real prices) | Provider terms | Daily snapshots |
| **Exchange rates** | Daily CAD rates | Bank of Canada Valet API | Open | Daily |

Inside Airbnb covers only some cities. A first check will list which of the trip's cities it covers (likely candidates include Tokyo, Hong Kong, Taipei, Singapore and Bangkok); uncovered cities simply have no Airbnb layer.

## Architecture

The pipeline is a new Python package in the repo. Python, DuckDB and Parquet are the standard data tools and keep the data work separate from the app. It ends by writing a **seed bundle** that the existing TypeScript loader puts into the graph, so all Cypher stays in one place.

```
             ┌──────────── GitHub Actions (scheduled) ────────────┐
 sources ──► │ extract ─► raw/ ─► stage ─► match ─► curate ─► enrich ─► embed │ ──► gs://trippr-data/
             └────────────────────────────────────────────────────┘          raw/  staging/  curated/  bundles/
                                                                                              │
                                                     Cloud Run Job (inside the VPC) ◄─────────┘
                                                     load bundle ─► FalkorDB (MERGE, idempotent)
```

| Layer | Choice | Why |
|---|---|---|
| Language | Python 3.12, managed with `uv`, in `pipelines/` | The usual language for data work; DuckDB, Polars, pydantic and pytest are all first-class |
| Engine | **DuckDB** with the `httpfs` and `spatial` extensions | Reads remote Parquet with a bounding box, does spatial joins, runs on a laptop or a CI runner, needs no server |
| Storage | **Google Cloud Storage** bucket `trippr-data`, laid out as `raw/<source>/<date>/`, `staging/`, `curated/` and `bundles/` | Cheap, versioned by date, already in the project; every run is reproducible from its raw files |
| Format | Parquet throughout; the bundle is Parquet plus a JSON manifest | Typed, compressed, readable by DuckDB and BigQuery |
| Orchestration | Scheduled **GitHub Actions** workflows for extract to bundle (signing in to Google Cloud with the existing workload identity federation); a **Cloud Run Job** for the load | The database is only reachable inside the VPC, so the load runs there; everything else runs free on GitHub's runners |
| Loader | The API image run with a different command (`node dist/load-bundle.js`), reusing the repository layer and idempotent `MERGE` | One Cypher layer, tested on FalkorDB and Neo4j as today |
| Analytics (optional) | BigQuery external tables over the curated Parquet | Lets the data be queried and charted without copying it |

### Stages

1. **Extract**: one module per source. Writes raw files exactly as received, plus a `_meta.json` (source, licence, query, row count, fetch time, checksum). Extraction is limited to each city's bounding box: a radius around the city's coordinates, 25 km for big cities and 10 km for small ones, set in the city seed.
2. **Stage**: maps each source to one common `staged_place` schema (below), normalises names (Unicode NFKC, trimmed punctuation, romanised and local-script names kept separately) and maps each source's categories onto Trippr's taxonomy.
3. **Match**: entity resolution across sources (see "Entity resolution").
4. **Curate**: picks golden records, ranks them, and selects the top places for each city into the graph.
5. **Enrich**: LLM batch enrichment, cached by a hash of each record's content, so re-runs only pay for changed places.
6. **Embed**: computes a vector for each curated place.
7. **Bundle**: writes `bundles/<date>/` with places, sources, embeddings and a manifest; the load job picks up the newest bundle that passed all checks.

### Staged schema

| Field | Notes |
|---|---|
| `source`, `source_id` | e.g. `overture` and its GERS id, `osm` and `node/123` |
| `name`, `name_local`, `name_en` | Local script kept for matching CJK names |
| `category_source`, `category` | Source category and Trippr's taxonomy |
| `lat`, `lon` | WGS84 |
| `city_code` | The nearest Trippr city within that city's radius; otherwise dropped |
| `address`, `website`, `phone`, `opening_hours` | When the source has them |
| `wikidata_qid` | From OSM tags, Overture source references or Wikivoyage |
| `signals` | Source confidence, Wikidata sitelink count, whether Wikivoyage lists it |
| `licence`, `fetched_at`, `raw_ref` | Provenance |

### Taxonomy

A fixed list of about 30 categories (viewpoint, museum, temple or shrine, park or garden, hike, beach, market, street food, restaurant, café, bar, nightlife, theme park, aquarium or zoo, shopping, landmark, historic site, gallery, performance, sports venue, onsen or spa, tour, and so on). Each maps to one of the five colour tags the app already uses (sport, tech, nature, culture, food), or to "other". Each source's mapping is a checked-in CSV, so changes show up in review.

## Feature 2: Activity catalogue

### Entity resolution

The same place appears in several sources under different names, scripts and coordinates ("Shibuya Sky", "SHIBUYA SKY", "渋谷スカイ", 40 m apart).

1. **Blocking**: only compare places in the same city, within neighbouring geohash-7 cells (about 150 m), whose categories are compatible.
2. **Strong links first**: a shared Wikidata QID, or a shared website domain plus a distance under 300 m, is a match.
3. **Scored pairs**, combining:
   - name similarity: the best of token-set ratio and Jaro-Winkler across the `name`, `name_en` and `name_local` variants
   - distance: full score under 75 m, falling to zero at 500 m
   - category agreement
   - matching phone numbers or addresses

   It starts as a hand-weighted score. If it isn't accurate enough, it moves to logistic regression trained on the labelled pairs.
4. **Clustering**: union-find over accepted pairs, with a guard that splits clusters wider than 500 m.
5. **Survivorship**: one golden record per cluster, with a field-level precedence per source:
   - names and descriptions from Wikidata or Wikivoyage
   - coordinates from OSM or Overture
   - websites from Overture or Wikidata
   - opening hours from OSM

   Every golden record keeps its list of `sources[]`.
6. **Evaluation**: about 400 hand-labelled candidate pairs across 6 cities (Japan, China, Korea, Vietnam and Thailand, so several scripts are represented) give precision and recall at the chosen threshold, reported on every run. The target is 95% precision and 85% recall; false merges are worse than missed ones.

### Ranking and curation

- `score` = sources agreeing + log of Wikidata sitelinks + listed in Wikivoyage + source confidence + category weight (sights outrank chain cafés).
- **Graph budget:** the FalkorDB VM has 1 GB of memory, so the graph gets about **8,000 curated activities**. Each city's share comes from its size and how many nights the routes spend there, with a floor of 20 and a cap of 300. Everything else stays in the data lake and in search results from it (see Feature 4).
- **Existing hand-written activities** win when they match. They keep their id, votes, comments and plans; the pipeline only fills empty fields.
- **New activities are ideas,** never planned. A source change can't remove an activity the group has planned or voted on; it's marked "no longer listed" instead.

### Graph changes

- Activity gains `catalogue: true`, `category`, `summary`, `durationMin`, `bestTime`, `score`, `sources` (JSON with each source's id and licence) and `embedding` (a vector, see Feature 4).
- `(:Activity)-[:FROM_SOURCE {sourceId, fetchedAt}]->(:DataSource {id, name, licence, url})`, so licences can be queried and the Data page can count by source.
- The Activities page gets filters for "From the catalogue" and category, and pages results 50 at a time, since a city can now have hundreds of ideas.

## Feature 3: LLM enrichment

- **What each curated place gets:**
  - `tags` (from the fixed taxonomy)
  - `summary` (one sentence, at most 140 characters, written only from the source text it was given)
  - `durationMin`
  - `bestTime` (morning, afternoon, evening, night or any)
  - `indoor` (yes or no)
  - `priceLevel` (free, $, $$, $$$)
  - `goodFor` (rain, families, nightlife, views)
- **Inputs:** only the golden record's fields and source descriptions. The prompt says to leave a field empty rather than guess, and to never add facts that aren't in the input.
- **How it runs:**
  - Claude's **Message Batches API** (half price, results within 24 hours) with structured output for the schema.
  - The shared system prompt is cached.
  - Results are keyed by content hash, so unchanged places are never sent again.
  - The model is chosen by the eval: start with a small model and use a larger one only if the small one misses the targets.
- **Eval:** 200 places labelled by hand, measured per field: tag F1, duration within ±30 minutes, bestTime accuracy. Summaries are checked for unsupported claims by a separate check (a second model call with a rubric), and a sample is also read by a person. Targets are 0.85 tag F1 and at most 2% summaries with unsupported claims.
- **Cost:** the pipeline prints an estimate before submitting a batch (records × average tokens × price) and refuses to submit without `--yes` when it's over a set limit (`ENRICH_BUDGET_USD`, default 10).
- **Guardrails:** the output is schema-checked; a URL in a summary is dropped; enriched fields are marked `ai: true` in the app ("Summary written by AI from Wikivoyage and OpenStreetMap").

## Feature 4: Semantic search and recommendations

### Embeddings

- **Model:** a multilingual model, because names and descriptions mix English, Japanese and Chinese. Recommendation: `multilingual-e5-small` (384 dimensions), run locally in the pipeline. Running it locally has no per-call cost and gives repeatable results.
- **Query time:** the API needs the same model to embed a question. It would run in Node through ONNX (transformers.js) if the Cloud Run memory allows. The alternative is a hosted embedding API (Voyage AI) for both pipeline and queries. A spike decides; the interface is the same either way.
- **What gets embedded:** for each curated place, "name · category · city · summary · Wikivoyage text".
- **Vector index:** both databases have one (FalkorDB `CREATE VECTOR INDEX … OPTIONS {dimension, similarityFunction}` with `db.idx.vector.queryNodes`; Neo4j vector indexes with `db.index.vector.queryNodes`). The exact syntax is checked in the first PR and kept in dialect files like today. 8,000 × 384 floats is about 12 MB, which fits.

### Search

- `GET /trips/:id/search?q=…&city=…&near=lat,lon&km=…&category=…` (viewers can search too).
- **Hybrid ranking:**
  1. vector similarity on the question, finding candidates
  2. filters (city, distance from a point such as the booked hotel, category, open on that weekday when opening hours are known)
  3. reranking that blends similarity with `score`, the group's votes, and a boost for places in the current route's cities
- **Results beyond the graph:** results can also come from places that weren't loaded into the graph. A small Parquet index of the long tail goes in the bundle, and the API queries it with DuckDB in Node. A spike checks the memory; if it doesn't fit, search covers the graph only. Picking a result from the long tail adds it as a new idea.
- **Web:** a search box on the Activities and Map tabs; results show on the map with "Add idea" and "Plan at stop".
- **Assistant:** a new read-only `semantic_search` tool, so "quiet viewpoints at sunset near our Osaka hotel" runs the hybrid search.

### Recommendations

- **Group taste:** the average embedding of what the group upvoted and planned, minus a weighted average of what it downvoted. Each member also gets their own taste vector.
- **Candidates:** catalogue places in the route's cities that aren't planned yet, ranked by similarity to the group taste and by `score`, diversified with maximal marginal relevance so a city's list isn't ten ramen shops.
- **Explanations:** each suggestion cites its nearest liked activity ("Because the group liked Liziba station: another rail landmark in Chongqing").
- **Offline eval:** leave out 20% of the group's upvotes; report hit rate at 10 and NDCG at 10, with a "most popular" baseline to beat.
- **Web:** "Suggested for this stop" on each stop card and in the Activities drawer.

## Feature 5: Stay analytics

### Hotel listings

- Areas gain a `radiusKm` (default 1.5 km around the existing centre point; editable).
- Hotels from Overture, OSM and Foursquare within each Area's radius become `Hotel` nodes with `catalogue: true`. They come with name, coordinates, website and a star rating when known. They have no price and are never marked booked.
- The hotel drawer lists them by Area next to the group's own shortlisted hotels, with the existing Booking.com search link.

### Inside Airbnb market data

- **Pipeline:** for each covered city, pull the latest `listings.csv.gz` and, if useful, `calendar.csv.gz`, then clean them:
  - parse prices
  - convert to CAD at the snapshot date's Bank of Canada rate
  - drop outliers above the 99th percentile and below a floor
- **Aggregation**, per Trippr Area (listings within the Area's `radiusKm` of its centre) and per H3 cell (resolution 8) for the map:
  - median price per night for an entire home and for a private room
  - review score (median and number of listings with 10 or more reviews)
  - listing density
  - share of entire homes
  - rough booked share from the calendar (busier areas are usually more central)
- **Area score:** a weighted blend of value (price against the city median), reviews, how central it is (distance to the city centre and the nearest rail station from the existing hubs) and density. It's shown with its parts, never as a bare number. The weights are in config, and the score explains itself in the Area card ("Cheaper than 70% of Osaka listings, reviews 4.8, 6 min to Namba station").
- **Web:**
  - Area cards show these numbers next to the existing vibe tags.
  - The Map tab gets an optional "Stay prices" heat layer (H3 cells).
  - A "Search Airbnb in this area" link opens Airbnb's own search with the stop's dates and group size.
  - Individual listings aren't shown.
- **Attribution:** "Data from Inside Airbnb (insideairbnb.com), CC BY 4.0", with the snapshot date.

### Live hotel prices

- **Spike first:** compare LiteAPI, Hotelbeds and the Booking.com affiliate API on sandbox access, coverage of the trip's cities, terms for showing prices, and cost.
- **Behind an interface:** `HotelRates.search({ city, area?, checkIn, checkOut, adults, rooms })`, with prices cached for 6 hours and fetched only for the stop's dates when someone opens the drawer. Off unless its key is set; tests use a fake.
- **Web:** the hotel drawer shows "from $X/night" for open-data hotels the provider can match (by name and distance, using the same matcher as Feature 2), with the provider's booking link.

## Feature 6: Flight prices

- **Which routes:** every flight hop in the current route of each trip, plus the flight home. Each is searched for the planned date and ±3 days, with the group size.
- **Provider:** Travelpayouts Data API first, which gives real cached prices from searches and is free with an affiliate token. The adapter interface allows Duffel later for bookable offers. Google Flights stays as the deep link already on each option.
- **Daily snapshots:** a scheduled job writes `raw/flights/<date>/` and appends to `curated/flight_prices/` (Parquet, partitioned by snapshot date). Each row has origin, destination, departure date, snapshot date, lowest price in CAD, airline, stops and the provider.
- **Analytics:**
  - price history for each hop
  - the cheapest day in the ±3 day window
  - **"book now or wait"**: the current price's percentile against this hop's history and the days until departure, shown as "Lower than 80% of prices we've seen" or "Prices usually drop until about 6 weeks out", labelled as an estimate
  - when a snapshot is 15% below the previous low, the trip's live feed gets a notice
- **Web:** each flight option in Travel options shows a small price chart and the signal. The Booked tab's "still to book" list shows the latest price.
- **Graph:** a `Leg` that's still an idea gets `priceCad` (latest), `priceAsOf` and `priceSource`. The full history stays in Parquet and is read through a small API endpoint, so the graph stays small.

## Feature 7: Data quality and the Data page

- **Checks** run inside the pipeline with DuckDB SQL and pytest. Any failure stops the bundle, so the app keeps its last good data:
  - row counts per source and city within the expected range (±40% of the last run)
  - null rates on key fields
  - coordinates inside the city's radius and the country's bounding box
  - no duplicate golden records within 50 m with the same name
  - every record has a licence
  - enrichment outputs pass the schema
  - entity-resolution precision on the labelled pairs above target
- **Run report:** each run writes a Markdown report (counts by source and city, check results, eval scores, cost) to the GitHub Actions run summary and to `gs://trippr-data/reports/<date>.md`.
- **Data page** in the app (`/data`, public): sources with licences and attribution, counts, last refresh, latest quality and eval results, and the pipeline diagram. It meets the attribution requirements (OSM, Wikivoyage, Inside Airbnb, Overture, Foursquare) and doubles as the portfolio summary.

## Provenance and licences

- **A source registry** (`pipelines/sources.yaml`) lists each source's name, URL, licence, attribution text, terms checked on (date) and allowed uses. The pipeline refuses to run a source without an entry.
- **OpenStreetMap (ODbL):** a database derived from OSM and made public must be offered under ODbL. Trippr keeps OSM-derived fields traceable (`sources` and `FROM_SOURCE`) and states this on the Data page; the curated bundle with OSM fields isn't published as a dataset.
- **Wikivoyage text** is CC BY-SA. Quoted descriptions keep attribution, and AI summaries are only written from it alongside other sources and marked as AI-written.
- **Inside Airbnb:** aggregates and attribution only; no individual listing pages are reproduced.

## Settings

- **Pipeline (GitHub Actions secrets and variables):**
  - `DATA_BUCKET`
  - `ANTHROPIC_API_KEY` (enrichment; a secret)
  - `ENRICH_BUDGET_USD`
  - `TRAVELPAYOUTS_TOKEN` (a secret)
  - `CITY_RADIUS_DEFAULT_KM`
- **API:**
  - `SEARCH_ENABLED`
  - `EMBEDDINGS` (`local` or `voyage`)
  - `HOTEL_RATES_PROVIDER` plus its key (a secret)
  - `FLIGHT_PRICES_ENABLED`

New secrets go in Secret Manager, as today.

## Testing

- **Pipeline unit tests (pytest):**
  - each source's staging on small checked-in fixtures
  - category mapping
  - name normalisation, including CJK
  - entity-resolution scoring and clustering
  - survivorship rules
  - Area aggregation
  - currency conversion
  - the booking signal
- **Golden dataset:** a tiny fixed "two cities" set runs the whole pipeline offline in CI in under a minute and is compared to an expected bundle.
- **Loader integration** (existing harness, both databases): loading a bundle is idempotent; existing activities keep votes, plans and ids; "no longer listed" works; the vector index answers a nearest-neighbour query.
- **API integration:** search (filters, distance, hybrid order with fixed vectors), recommendations with a fixed taste vector, flight price endpoints and the hotel rates adapter (fakes).
- **Evals** run by hand or monthly, never on pull requests: entity resolution, enrichment and search relevance (50 queries with judged results, reporting NDCG at 10).
- **e2e:** search on the Activities tab returns catalogue results and "Add idea" works.

## Cost

| Item | Estimate (confirm before turning on) |
|---|---|
| Cloud Storage | A few GB at most; well under $1 a month |
| GitHub Actions | Free for a public repo |
| Cloud Run Job (load) | Seconds of compute a day; effectively free |
| LLM enrichment | One-time run over about 8,000 places with a small model through the batch API, then only changed places. The pipeline prints the estimate first and stops at `ENRICH_BUDGET_USD` |
| Embeddings | Free when local; small per-token cost with a hosted API |
| Travelpayouts | Free with an affiliate token |
| Hotel rates | Free sandbox; live terms vary by provider |

## Build plan

One PR per row; CI green on FalkorDB and Neo4j, plus the pipeline's pytest suite, before merging.

| PR | Contents | Depends on |
|---|---|---|
| 1 | Pipeline skeleton: `pipelines/` with uv, DuckDB, source registry, staged schema, taxonomy CSVs; **Overture and Foursquare** extract and stage for the trip's cities; checks; run report; the scheduled workflow writing to GCS | None |
| 2 | OSM, Wikidata and Wikivoyage extract and stage; entity resolution with labelled pairs and eval | 1 |
| 3 | Curation and ranking; the bundle format; the **load job** (Cloud Run Job, idempotent, keeps votes and plans); graph changes and provenance; Activities filters and paging; Data page | 2 |
| 4 | LLM enrichment with the batch API, content-hash cache, cost guard, eval set; "Summary written by AI" in the app | 3 |
| 5 | Embeddings (spike: local or hosted), vector indexes in both databases, search API and UI, the assistant's `semantic_search` tool, search relevance eval | 3 (4 makes it better) |
| 6 | Recommendations with explanations, the offline eval, "Suggested for this stop" | 5 |
| 7 | Hotel listings from open data; Inside Airbnb pipeline, Area aggregates and scores, map heat layer, Area cards | 3 |
| 8 | Live hotel prices (spike, then adapter, cache, drawer prices) | 7 |
| 9 | Flight prices: provider spike, daily snapshots, history endpoint, charts and booking signal, price-drop notices | 1 |
| 10 | Case study write-up in `docs/` and the README: architecture, metrics from the evals, costs, decisions | 4, 5, 7, 9 |

PRs 1 and 9 can start in parallel; 5 and 7 can run in parallel after 3.

## Risks

| Risk | Mitigation |
|---|---|
| Matching fails on CJK names | Match on local-script, romanised and English variants; strong links via Wikidata QIDs; labelled pairs from Japanese and Chinese cities; prefer missed matches to false merges |
| Too much data for the 1 GB VM | Graph budget of about 8,000 places; the long tail stays in Parquet; memory checked after each load |
| An LLM summary invents a fact | Inputs only from sources, a schema, an unsupported-claim check, marked as AI-written, and a person reads a sample |
| A licence is misread | A source registry with the terms date; the Data page states each source's licence; ODbL and CC BY-SA handled explicitly |
| A provider changes terms or needs approval | Hotel and flight prices sit behind adapters and are optional; the app works without them |
| Enrichment cost overruns | Content-hash cache, the batch API, an estimate before submitting, and a hard budget |
| Overture or Foursquare file sizes | Read with DuckDB using bounding boxes on remote Parquet; nothing downloads in full |
| Scheduled runs break silently | The run report, failed checks fail the workflow (email from GitHub), and the Data page shows freshness |

## Open questions

1. **Python for the pipeline:** OK to add a Python package to the repo? This spec recommends it, as the expected tooling for data engineering.
2. **Embeddings:** local `multilingual-e5-small` (free, decided by the memory spike) or a hosted embedding API?
3. **Graph budget:** about 8,000 activities in the graph, or fewer to keep the Activities page focused?
4. **Enrichment budget:** a hard cap for the first full run (spec default $10)?
5. **Hotel price provider and flight provider:** pick after the spikes, or skip live hotel prices and keep only open-data hotels and Inside Airbnb?
