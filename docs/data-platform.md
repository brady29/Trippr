# Data platform: curation, bundle and load job

How curated places get from the pipeline into the graph. This is PR 3 of the [Trip Data Platform Spec](data-platform-spec.md); the pipeline's earlier stages are in [pipelines/README.md](../pipelines/README.md).

```
staged ─► (match) ─► curate ─► bundle ──► bundles/<date>/ ──► load job ──► graph ──► API ──► Activities and Data pages
```

## Curate

`python -m trippr_data curate` ranks golden records and chooses what goes into the graph. Settings are in `pipelines/config/curation.yaml` and `category_weight.csv`.

- **Score** = sources agreeing + log of Wikidata sitelinks + listed in Wikivoyage + best source confidence + category weight (sights outrank chain cafes) + a small bonus for a website, minus a penalty for a branded chain in a chain-sensitive category. Candidates under a minimum confidence are dropped.
- **Budget**: about 8,000 places in total (`CURATE_BUDGET` overrides). A city's share is proportional to `log(1 + eligible places) × (1 + nights / 5)`, where nights is what the seeded routes spend there, clamped to a floor of 20 and a cap of 300 and re-shared so the total holds.
- **Mix**: inside a city each colour tag gets a target share (culture 30%, nature 25%, food 20%, sport 5%, tech 5%, other 15%), best places first, no category over its own share; what a tag cannot fill goes to the best of the rest. The first full run on the real data gave culture 32%, nature 25%, food 19%, other 14%, sport 4%, tech 4%, not 76% food.
- **Input**: `matched/<date>/golden.parquet`, the match stage's output; `pipelines/src/trippr_data/golden.py` lists the columns curate reads from it (names, coordinates, Wikidata sitelinks, Wikivoyage listing, confidence, `sources[]`). Curate stops with a clear error when there is no match output.
- **Ids** are stable: `cat-` plus a hash of the place's Wikidata QID, else of its best source record. The load job also matches by source record, so an id that changes when clusters change does not lose votes.
- Every place keeps the list of source records it was built from, each with its licence. A pair the match stage missed (same name, same city, within 50 m) is folded into the better-scored place, which takes over its source records.

## Bundle

`python -m trippr_data bundle` writes `bundles/<date>/`:

| File | What |
|---|---|
| `places.jsonl.gz` | One curated place per line, ordered by city and rank. What the load job reads |
| `places.parquet` | The same places for DuckDB and BigQuery |
| `sources.json` | The registry entries behind the places: licence, attribution, terms date, counts, freshness |
| `manifest.json` | Counts, file checksums (SHA-256) and the check results; `enrichment` and `evals.enrich` when the bundle is enriched, a `stay` section when the stay files are there |
| `enrichment.jsonl.gz`, `enrichment.parquet` | Optional. The LLM enrichment (see below), one line per enriched place, joined to the places by id |
| `stay_unit.jsonl.gz`, `hotels.jsonl.gz` | Optional: stay analytics units and open-data hotels (see [Stay analytics](#stay-analytics-pr-7)). Parquet copies sit beside them |

The JSON shapes are defined twice, in `pipelines/src/trippr_data/bundle.py` (pydantic) and `packages/contracts/src/catalogue.ts` (zod). The pipeline's golden test writes a bundle from the fixtures and commits it (`pipelines/tests/fixtures/expected/bundle/`); the contract tests, the API integration tests and the e2e tests all read that same bundle, so the two sides cannot drift.

Bundle checks (any failure sets `checks.passed: false`, so the bundle is never loaded): non-empty; unique ids; every place has sources and a licence for each, all listed in `sources.yaml`; categories in the taxonomy; coordinates inside the city radius and the country box; no two places with the same name within 50 m; within the budget, floor and cap; no colour tag far above its share; plus the staging checks of the same run.

### Enrichment

After `enrich` has run (a laptop job, see [pipelines/README.md](../pipelines/README.md)), the bundle step adds the AI-written fields: `tags` (taxonomy categories), a one-line `summary`, `duration_min`, `best_time`, `indoor`, `price_level`, `good_for`, a `display_name` suggestion with `is_generic_name`, and `provenance` (`summary_ai`, model, prompt version, date, input sources) with the sentence to show (`ai_label`, e.g. "Summary written by AI from Wikidata and Wikivoyage"). The zod shape is `bundleEnrichmentSchema`. The extra bundle check `enrichment.summary_provenance` fails the bundle when any summary is not marked as AI-written, and the load job refuses such a bundle again on its side.

**Load job.** Enrichment goes onto the Activity node as `summary`, `summaryAi`, `aiLabel`, `enrichTags`, `durationMin`, `bestTime`, `indoor`, `priceLevel`, `goodFor`, `displayName`, `genericName`, `enrichModel`, `enrichPromptVersion` and `enrichedAt` (empty lists are stored as nothing). It is part of the place's content hash, so a place is refreshed when its enrichment changes and not otherwise; a bundle that comes without enrichment leaves what the graph already holds. A hand-written activity that was matched to a place **keeps its own summary** (the AI summary is only added while it has none, or replaced while it is still the AI's), and the other fields are only filled while empty, or refreshed once the pipeline filled them. Titles are never changed: `display_name` is a subtitle for places whose own name is generic or formal (`is_generic_name`).

**App.** Activities show the summary with the label from the data ("Summary written by AI from ..."), and badges for duration, best time of day, indoor or outdoor and price level; they are estimates and say so on hover. The Activities page filters on `bestTime`, `indoor`, `durationMax` and `priceLevel` (below). The Data page has an "AI enrichment" panel: places enriched out of the bundle, how many have a summary, the model and prompt, the date, and the `eval-enrich` scores from the manifest when the pipeline recorded them.

`python -m trippr_data run` now ends with curate and bundle after a passing check, adds a bundle section to the run report and uploads `bundles/` with the rest.

## Load job

The job reads the newest bundle that passed its checks and verifies (checksums, schema, counts), skipping and logging any it cannot use, then merges it into the graph.

```sh
pnpm db:up && pnpm db:reset
pnpm db:load-bundle --bundle pipelines/out/bundles --dry-run   # what would change; writes nothing
pnpm db:load-bundle --bundle pipelines/out/bundles             # load it
pnpm db:load-bundle --bundle gs://trippr-bucket-data/bundles          # or from Cloud Storage
```

Options: `--bundle` (folder or `gs://bucket/prefix`; default `$BUNDLE_LOCATION`, else `gs://$DATA_BUCKET/bundles`), `--date` (a specific bundle), `--trip` (default `$CATALOGUE_TRIP_ID`, else the only trip), `--dry-run`, `--json`. Reading from Cloud Storage uses `@google-cloud/storage` with the job's default credentials; the tests use local folders only.

What it does, and does not do:

- New places become **ideas** on the trip's library (`catalogue: true`), never planned.
- Places already in the graph (same id, or sharing a source record) are refreshed in place. Running the same bundle twice changes nothing (places carry a content hash).
- A hand-written activity that is the same place (same city, same name or Maps query, and within 500 m if it is already pinned) **keeps its id, votes, comments, plans, title and tags**; only its empty fields (pin, website, phone, ...) are filled and its sources recorded.
- It never overwrites an edited title or website, or a pin placed by hand (`placeStatus: manual`) or found by lookup. Votes, comments, plans and trip data are never touched.
- A catalogue place the newer bundle drops is **removed if nobody used it**, and otherwise kept and marked `listed: false` ("no longer listed"): voted, commented, planned, edited or hand-pinned places are never lost.
- A catalogue place someone deletes in the app is hidden, not removed, so the next load does not bring it back.
- It writes a `DataLoad` node (bundle date, counts, check results) that the Data page shows.

### Graph model

Activity gains `catalogue`, `category`, `score`, `rank`, `listed`, `nameLocal`, `phone`, `openingHours`, `wikidataQid`, `sources` (JSON of source id, record id and licence), `sourceKeys`, `sourceIds`, `catalogueId`, `contentHash`, `bundleDate`, and the enrichment fields (see Enrichment above). `(:Activity)-[:FROM_SOURCE {sourceId, fetchedAt, licence}]->(:DataSource {id, name, licence, url, attribution, ...})` makes licences queryable. Constraints and indexes are in `db/schema/*.cypher`; the job applies them first, and they are idempotent.

### API

| Route | |
|---|---|
| `GET /trips/:id/activities/page` | The whole library, filtered and paged: `scope` (`all`, `mine`, `catalogue`), `city`, `tag`, `category`, `q`, `source`, `minScore`, `maxRank`, `fixedDates`, `bestTime`, `indoor`, `durationMax`, `priceLevel`, `sort`, `offset`, `limit` (50, max 100). Viewers can read it |
| `GET /trips/:id/activities/facets` | Filter menus and headline numbers, with counts for the enrichment filters (`enrichment`) |
| `GET /trips/:id/activities` | Unchanged for existing callers: the group's own ideas, plus catalogue places it voted on, commented on or planned. Every activity read (list, page, a stop's library, the result of a vote or edit) carries `enrichment` when the place was enriched |

Enrichment filters: `bestTime` (`morning`, `afternoon`, `evening`, `night`, `any`; places best at any time always match), `indoor` (`true` or `false`), `durationMax` (minutes, at most) and `priceLevel` (`free`, `$`, `$$`, `$$$`, exact). A place the model could not tell (no duration, no indoor flag) is left out of that filter.
| `GET /data/sources` | Public. Sources with licences and attribution, counts, freshness, the latest load and its checks |

The stop drawers and the route editor's library show catalogue places only once the group has engaged with them, so a city's few hundred places do not bury its ideas.

## Semantic search

PR 5 ([spike](embeddings-spike.md), [spec](data-platform-spec.md) Feature 4). Place vectors are made once a month on the owner's laptop with the `embed` stage (BGE-M3, 1,024 dimensions) and loaded with the bundle; only the short question is embedded at request time, by Cloudflare Workers AI (`@cf/baai/bge-m3`), so the 512 MiB API never loads a model.

```
laptop:  embed ─► out/embeddings/<date>/{manifest.json, embeddings.f32, ids.json, embeddings.parquet}
                          │ upload next to the bundles (gs://bucket/embeddings/<date>)
load job: verify checksums, model, size and place ids ─► Activity.embedding + vector index + EmbeddingIndex node
API:      GET /trips/:id/search?q=… ─► embed q (hosted, cached, 2.5 s timeout) ─► nearest places ─► words ─► rank
```

### Make the vectors (on the laptop)

```sh
cd pipelines
uv sync --extra embed                       # once: onnxruntime + tokenizers + huggingface-hub (no PyTorch)
uv run python -m trippr_data embed          # newest bundle; default model bge-m3-q8; ~24 min for 8,000 places, first run downloads 570 MB
```

It writes `out/embeddings/<date>/`: `manifest.json` (model, exact weights, dimensions, text version, counts and sha256 of every file), `embeddings.f32` (the matrix: raw little-endian float32, one row per place), `ids.json` (place ids and content hashes in row order) and `embeddings.parquet` (the same, for the pipeline's own tools). The Node load job reads the first three, so it needs no Parquet library; their checksums are in the manifest and are checked before anything is written. A place whose text did not change is not embedded again (content-hash cache), so later runs take seconds. The enrich stage's summaries are added to the text automatically when `out/enriched/` has them.

Upload it beside the bundles, with the same date (`bundles/<date>/` and `embeddings/<date>/`): `gcloud storage cp -r out/embeddings/<date> gs://$DATA_BUCKET/embeddings/` (an action for the owner; nothing in the repo does it).

### Load the vectors

```sh
pnpm db:load-bundle --bundle pipelines/out/bundles                     # places, then vectors from ../embeddings/<same date>
pnpm db:load-bundle --bundle gs://trippr-bucket-data/bundles           # vectors from gs://trippr-bucket-data/embeddings/<date>
pnpm db:load-bundle --bundle pipelines/out/bundles --dry-run           # reports how many vectors it would write
```

| Option | Meaning |
|---|---|
| `--embeddings <folder or gs://…>` | Where the `embeddings/<date>/` runs are (default `$EMBEDDINGS_LOCATION`, else the `embeddings` folder next to the bundles folder) |
| `--embeddings-date` | Use this run instead of the one with the bundle's date |
| `--no-embeddings` | Load places only |
| `--rebuild-index` | The model or vector size changed: drop the vector index and every stored vector, then load |

What it checks, before writing anything:

1. The manifest is valid and `embeddings.f32` and `ids.json` match its sha256 and its counts (rows x dimensions x 4 bytes). A run that fails is skipped with the reason, or is an error when you named it.
2. The run covers the bundle: place ids must overlap (a run for another bundle is refused; places without a vector still load and are found by words).
3. **Model and size.** If the graph already holds vectors (the `EmbeddingIndex` node records model, dimensions, text version and count), a run from another model family or another size is **refused and nothing at all is loaded**. `bge-m3` and `bge-m3-q8` count as the same model (the spike measured no loss). `--rebuild-index` drops the index and the old vectors and loads the new run.

Then it creates the vector index (idempotent), writes only the vectors whose content hash changed, waits for the index where the database builds it in the background, and records the revision the API uses to refresh its copy. Running it twice writes nothing the second time.

### Which path each database uses

| | FalkorDB v4.22.1 | Neo4j 5.26 Community |
|---|---|---|
| Vector on the node | `SET a.embedding = vecf32($v)` | `CALL db.create.setNodeVectorProperty(a, 'embedding', $v)` |
| Index | `CREATE VECTOR INDEX FOR (n:Activity) ON (n.embedding) OPTIONS {dimension: 1024, similarityFunction: 'cosine'}` | `CREATE VECTOR INDEX activity_embedding IF NOT EXISTS FOR (n:Activity) ON n.embedding OPTIONS {indexConfig: {`vector.dimensions`: 1024, `vector.similarity_function`: 'cosine'}}` |
| Query | `CALL db.idx.vector.queryNodes('Activity', 'embedding', $k, vecf32($q)) YIELD node, score` | `CALL db.index.vector.queryNodes('activity_embedding', $k, $q) YIELD node, score` |
| Score | cosine **distance**, ascending; similarity = `1 - score` | `(1 + cosine) / 2`, descending; similarity = `2 * score - 1` |
| Default use | unfiltered questions: the index | unfiltered questions: the index |

The index is created by the load job with the dimension from the manifest, not by `db:migrate`, so a database or version without vector support cannot break the schema step for everything else. The statements are in `apps/api/src/repositories/cypher/search/`, one dialect file each.

Neo4j's index is approximate: it is scalar-quantised by default, and in CI with 32-dimension test vectors it scored lower hits up to 0.06 above the exact cosine (the order of the top five and the best hit's score, within 0.011, matched). Real 1,024-dimension vectors should lose less; that is unmeasured. So the API's exact path is the more precise one (and the only one that filters), and similarity numbers are used for ranking only: the page shows a sentence ("very close", "close", "loosely related"), never a percentage.

Neither index can filter. So a question with a city, tag, category or `near` filter, and any question when the index errors or comes back empty, is answered by the **exact path**: every vector in one `Float32Array` in the API (8,000 x 1,024 float32 = 33 MB), filled page by page from the graph on first use and again when the load job writes new vectors, and scanned with a dot product. It is exact, applies filters before ranking (a filtered answer is never short), and needs no index. Measured on a laptop with 8,000 random 1,024-dimension vectors: 0.7 s to fill, 33 MB matrix, process memory from 69 MB to about 200 MB right after the fill (that includes garbage not yet collected), 15 ms per query. That fits the 512 MiB instance; `matrix.ts` refuses to load more than 160 MB. **Check the real instance's memory after the first load**: it was not measured on Cloud Run.

`SEARCH_VECTOR_PATH=auto` (default) is the rule above; `index` or `exact` forces one. If CI shows that a database lacks vector support or a feature, `exact` is the supported answer for that database and needs no code change. The integration tests (`apps/api/test/search.test.ts`, both databases in CI) check, with messages that print the database, the scores and the exact cosine they were compared with:

- the index is created, filled and answers; its scores equal the exact cosine (this settles FalkorDB's distance and Neo4j's 0..1 scale in code);
- the index and the exact scan return the same places in the same order;
- dropping the index falls back to the exact scan;
- no ordinary query returns a vector (a static scan of every `.cypher` file, and the JSON of the library endpoints).

**Status: written from the vendor documentation and the `falkordb` client's own index API; not executed locally** (Docker would not start on the machine this was written on). CI is the first run. Only CI can settle: that `neo4j:5.26-community` accepts `CREATE VECTOR INDEX` and `db.create.setNodeVectorProperty`, that FalkorDB v4.22.1's `queryNodes` runs in a read-only query, and the exact `DROP VECTOR INDEX` behaviour that `--rebuild-index` relies on.

### The endpoint

`GET /trips/:id/search?q=&city=&tag=&category=&near=lat,lon&km=&limit=` (viewers can search; non-members get 404, signed-out callers 401).

- **Hybrid ranking**: vector similarity (cosine, scaled so 0.3 counts for nothing and 0.75 for everything), a words score (the question equal to a name 1.0, inside a name 0.9, each word found in a name up to 0.8, in the address, category or city name up to 0.5 together) and a small prior from the place's rank in its city. Weights 0.55 / 0.40 / 0.05, plus 0.2 when the question is, or sits inside, the place's name, so a place named like the question comes first (even with no vector) while a very close meaning still beats a weak name match. Candidates are the index's nearest list (over-fetched 4 to 10 times the page) plus the database's word matches; filters apply to both, and `truncated: true` says a filter left fewer than asked on the index path.
- Each hit carries the same card the Activities page shows (votes, tags, sources and licences), `match` (`meaning`, `name`, `both`, `words`), a `reason` sentence, the similarity, and the distance when `near` was given.
- **Words only** (`mode: "lexical"`, with a `notice` the page shows) when: no query embedder is configured (`no_embedder`), no vectors are loaded (`no_vectors`), the loaded vectors are from another model or size (`model_mismatch`), the embedder failed or took longer than `SEARCH_EMBED_TIMEOUT_MS` (`embedder_unavailable`; after three failures in a row it is skipped for 30 s), the vectors could not be searched (`vectors_unavailable`), the member used today's allowance (`daily_limit`), or it is the demo account (`demo`, which never calls the hosted embedder).
- **Limits** per member: `SEARCH_RATE_PER_MINUTE` (default 30) searches a minute, answered with 429 and `Retry-After`; `SEARCH_DAILY_LIMIT` (default 150) searches a UTC day that call the hosted embedder. A repeated question comes from a 300-entry cache and costs nothing. Counts live in the API process, so with several instances the ceiling is per instance (the app runs one to a few).
- The assistant has a read-only `semantic_search` tool that calls this endpoint as the asking member, so it shares that member's limits and notices.

### Configure Cloudflare Workers AI

The owner created the credentials as Secret Manager secrets `trippr-cloudflare-account-id` and `trippr-cloudflare-api-token`. **No value is ever in the repo.**

| Variable | Meaning |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Both set: the API uses `@cf/baai/bge-m3`. Either missing: words only. |
| `SEARCH_EMBEDDER` | `cloudflare`, `off`, or `fake` (tests and the end-to-end run; refused in production) |
| `CLOUDFLARE_EMBED_MODEL` | default `@cf/baai/bge-m3` |
| `SEARCH_EMBED_TIMEOUT_MS`, `SEARCH_VECTOR_PATH`, `SEARCH_RATE_PER_MINUTE`, `SEARCH_DAILY_LIMIT` | see above |

Deploy: `.github/workflows/deploy.yml` maps the two secrets into the Cloud Run service when the repository variable **`CLOUDFLARE_QUERY_EMBEDDING`** is `true` (the secret names can be overridden with the variables `CLOUDFLARE_ACCOUNT_ID_SECRET` and `CLOUDFLARE_API_TOKEN_SECRET`). It is off by default because the deploy replaces the whole secret list each time and a missing secret fails the deploy. Before turning it on, check that both secrets exist and that the Cloud Run runtime service account has `roles/secretmanager.secretAccessor` on them. Locally, set the two variables in your shell or in `.env` (gitignored).

**Run the parity check before relying on it.** The hosted model must produce vectors that match the local ones (cosine above 0.98 for the same text). Nothing in this change calls the Cloudflare API: the request shape in `apps/api/src/services/search/embedder.ts` is from Cloudflare's documentation and a stubbed test. On the laptop, after `embed`:

```sh
cd pipelines
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… uv run python eval/search/parity_check.py bge-m3-q8 \
    --endpoint cloudflare:@cf/baai/bge-m3 --embeddings-dir out/embeddings/<date> \
    --corpus out/bundles/<date>/places.parquet --queries eval/search/queries_bundle.yaml
```

It sends 30 short query strings, prints the minimum and mean cosine between the local and hosted vectors and the top-10 overlap, and exits 1 below 0.98. If it fails, the fallback is a small Cloud Run service running the same model (option B in the spike): add an adapter next to `createCloudflareEmbedder` behind the same `QueryEmbedder` interface.

### Is search any good? (`eval-search`)

Two runs of the same labelled queries (89 on the bundle, 68 on the checked-in staged corpus, in `pipelines/eval/search/`), with the same metric definitions in Python and in TypeScript:

```sh
# 1. The model on the bundle, brute-force cosine (laptop; no database):
cd pipelines && uv run python -m trippr_data eval-search \
    --corpus out/bundles/<date>/places.parquet --queries eval/search/queries_bundle.yaml

# 2. The loaded graph through the real search service (index or exact path, hosted query vectors, words, ranking):
uv run python -m trippr_data eval-search --corpus out/bundles/<date>/places.parquet \
    --queries eval/search/queries_bundle.yaml --export-queries out/search-queries.json
cd .. && pnpm eval:search --queries pipelines/out/search-queries.json [--path index|exact|auto] [--min-mrr 0.5]
```

Run (2) once with the Cloudflare variables set and once without (words only) to see what the vectors add. The gap to (1) is the cost of the hosted query vector, the index and the word blending. In (2) a place the group adopted into an existing idea has that idea's id, so its hits do not count; that affects a few places, not the totals systematically.

Numbers on record (the spike's: brute-force cosine on the 8,000-place bundle, 89 queries; see [embeddings-spike.md](embeddings-spike.md)):

| | MRR | Success@1 | Recall@10 | NDCG@10 |
|---|---|---|---|---|
| fake hashing baseline (words-like) | 0.201 | 0.157 | 0.178 | 0.166 |
| BGE-M3 8-bit (what the app loads) | 0.680 | 0.584 | 0.563 | 0.594 |

**The graph eval (2) has not been run**: it needs the loaded graph and a Cloudflare token, neither available when this was written. Record its numbers here after the first load.

The web app has a "Search by meaning" box on the Activities page (press Search; the page's city, tag and category filters narrow it). A search box on the map tab is not built.

## Suggested for this stop (PR 6)

[Spec](data-platform-spec.md#recommendations). The stop drawer on the route editor has a "Suggested for this stop" panel: a handful of catalogue places in the stop's city that the group is likely to like next, each with the reason. It is built from the group's own votes, plans and comments and from the place vectors already stored on the Activity nodes. **Nothing on the request path embeds text or calls a model**, so it costs nothing, does not depend on Cloudflare, has no allowance, and works for the demo account.

```
GET /stops/:id/suggestions  ─►  the stop's city ─► the trip's activities there with their votes, plans, comments (one read)
                                                    + tags liked in other cities (two small reads)
                                                    + the stored vectors (the search service's in-memory matrix, shared)
                              ─► taste ─► score ─► diversify (MMR) ─► reasons ─► cards
```

### The endpoint

`GET /stops/:id/suggestions?limit=6&bestTime=&indoor=` (`limit` 1 to 20, default 6; `bestTime` is `morning`, `afternoon`, `evening` or `night`; `indoor` is `true` or `false`). Viewers can read it, a non-member gets 404 and a signed-out caller 401, like the other trip routes. The answer has the stop and city, `basis`, a `notice` (or null), counts of what the group liked and disliked here, the tags that shaped it, and `suggestions[]`: the same card the Activities page shows (votes, tags, AI label and badges, sources with licences), `reason`, `because` (`similar`, `tag` or `rank`), the liked place it resembles (`anchor`: title, how many voted, whether it is planned) and `closeness` (a word: "very close", "close" or "loosely related", never a number). The vector is never in the answer.

`basis` says what the list rests on:

| basis | when | what it does |
|---|---|---|
| `group_taste` | someone liked a place in this city that has a vector | similarity to the group's taste, diversified |
| `tag_preferences` | nothing liked here has a vector (or no vectors are loaded) but the group liked some tags (here or in other cities) | the city's catalogue ranking, leaning toward those tags |
| `catalogue_rank` | no signals anywhere | the city's catalogue ranking alone |

The `notice` is plain words for the panel: `cold_start` ("Nobody has voted on, planned or commented on places in Osaka yet, so these are the city's top-ranked places, leaning toward what your group liked elsewhere (culture). Vote on a few and they will follow your taste."), `no_taste` (the places liked here have no vector), `no_vectors` (none are loaded, so similarity was not used) and `none_left` (everything in the city is planned, voted on, or filtered out).

### How it ranks

All of it is in `apps/api/src/services/recommend/core.ts`, pure functions, with every constant in one `TUNING` object.

1. **Signals.** For each activity of the trip in the stop's city: an up-vote counts `1 / sqrt(n)` for a member who voted on `n` places here (so one person voting on everything does not outweigh three people voting on a few), a down-vote counts the same, minus. A plan in **any** route of the trip counts 1.5. A comment counts 0.25, at most two of them, and only on a place that is not net voted down. A place whose signals cancel out is dropped. So a place planned in another route counts as liked with no vote at all: the answer's `signals.liked` can be above 0 while `signals.members` (people who voted here) is 0, as with the seed's two planned Saigon ideas. They have no place vector, so that stop gets `tag_preferences` with the `no_taste` notice, not `cold_start`. A place the group planned and one member voted down is still net liked.
2. **Taste.** The weighted average of the liked places' vectors, minus half the weighted average of the disliked ones, normalised. (A place that is a near-copy of one the group voted down, cosine 0.85 or more, is never suggested.) Only places with a vector count here. The group's own hand-written ideas get a vector only when the load job adopted them into a catalogue place; the seeded trip has none (see the eval).
3. **Candidates.** Catalogue places in the stop's city, still listed, hidden by nobody, and **not planned in any route, not voted on, not commented on**; the group's own ideas are not candidates (they are in the drawer already). The `bestTime` and `indoor` filters use the enrichment fields as on the Activities page: a place the model could not tell is left out of a filter, never guessed.
4. **Relevance.** Half the similarity to the taste, half the similarity to the nearest liked place (a group that likes both temples and ramen is not served by their average, which sits between them), plus 0.05 of the city's own ranking as a tie-breaker.
5. **Diversity.** Maximal marginal relevance (lambda 0.7): repeatedly take the candidate with the best `0.7 * relevance - 0.3 * (its highest similarity to what is already picked)`, minus 0.04 for each pick already in its category. Near-duplicates and ten-of-one-category lists lose to the next different place.
6. **Cold start** (nothing liked here has a vector): the city's catalogue rank as a score (1 at rank 1, 0.5 at rank 11, 0.25 at rank 31), plus 0.5 for a place with a tag the group likes (net votes and plans in the trip's other cities count half, this city's liked places count fully), diversified the same way. The panel says so.
7. **Nearby cities.** Not built. The repo has no day-trip rule; a nearby city is its own stop, and a stop's suggestions are its own city's places.

Per-member taste vectors (the spec's "each member also gets their own") are not built: the endpoint answers for the group.

### The reason

Assembled by rules from facts the program holds, in `explain.ts`; never by a model, and the panel does not say it was. In order:

1. The nearest liked place, **when it is at least "close"** (cosine 0.45, as in search): "Similar to Fushimi Inari, which 3 of you voted for". Who: "N of you voted for", "one of you voted for", "you voted for" (when the member asking is the only voter), "... and planned", "your group planned", "your group commented on". A liked place the group voted for or planned is preferred over one it only commented on.
2. Else, if it carries a tag the group likes: "Top-ranked museum in Osaka; your group likes culture" (or "#2 museum in Osaka", "Ranked #14 in Osaka"). The rank is the place's rank inside its category in the city, then its rank overall; the tag is one of the group's two strongest.
3. Else the fact alone: "Top-ranked museum in Osaka", "Ranked #14 in Osaka", "Park in Osaka".

No similarity number is ever shown or sent as a percentage. A test over thousands of simulated suggestions checks that every "similar to" names a place the group really liked and the right number of voters.

### The panel

`components/suggested-for-stop.tsx`, placed in the stop drawer under the city's list. It reuses `ActivityItem` (AI label, badges, votes) and the catalogue footer (source and licence), adds the reason line with the closeness word, and two actions: **Add to ideas** (an up-vote: the place joins the city's list and leaves the suggestions) and **Plan here** (editors; the drawer's own planning). Two small filters (time of day, indoor or outdoor) pass `bestTime` and `indoor`. It shows a spinner while it loads, the notice for cold start and "nothing left", "Nothing to suggest in Tokyo yet" when it is empty and there is nothing to say, and an error with "Try again" that leaves the rest of the drawer working. It is in the stop drawer only; the stop card and the Map tab do not show it.

### Is it any good? (`eval:recommend`)

```sh
pnpm eval:recommend                      # golden bundle, FAKE vectors: a plumbing run (what CI-sized checks use)
pnpm eval:recommend --sweep              # plus rows for other diversity settings
pnpm eval:recommend --bundle pipelines/out/bundles --embeddings pipelines/out/embeddings --max-cities 20 --sweep   # the real catalogue and BGE-M3 vectors, the 20 biggest cities (all 108 take over an hour)
# options: --k 10 --max-rank 20 --seed N --profiles-per-city 4 --repeats 2 --liked 6 --max-cities N (the N cities with most places) --json --min-hit10 0.5
```

No database, network or key: it reads a bundle and a vector run from disk and calls the API's own scoring (`suggestForCity`). It exits 1 when an invariant fails.

**The seeded trip is too thin to leave out one at a time.** It has 274 hand-written ideas, **0 votes**, and 163 planned ideas, almost none of which is a catalogue place with a vector (a hand-written idea gets a vector only if the load job adopts it; the golden bundle adopts none, the real one 46 of the 163). So the groups are **synthetic**:

- Real: the places, their categories, ranks, tags, enrichment and vectors.
- Made up: the groups. A profile is "this group likes one category (or two) in this city". Its liked places (six) are sampled from the catalogue's places of those categories; three members vote them up at random (one member half the time, two 30%, all three 20%) and about a third are planned.
- **Leave-one-out:** for every liked place, hide it (its votes and plan are removed, it is an ordinary catalogue place again), build the suggestions from the other five and check where the hidden one lands among the city's candidates. hit@k is the share of cases with it in the top k; MRR is cut at 20.
- **Baselines**, on the same candidates: the catalogue's own rank; notability (Wikidata sitelinks, then number of agreeing sources); random.
- **Also measured**, on the same lists: distinct categories in the top 10, the share of the top 10 in the profile's categories, for two-category profiles how often both appear, and redundancy (mean pairwise similarity of the top 10).
- **Invariants** (must hold whatever the vectors): no suggestion is planned, voted, commented on or the group's own (must be 0); every suggestion has a reason (100%); every "similar to" names a liked place with the right voters and plan; no reason shows a number or credits a model; the same input gives the same list in any row order; a list is full when there are enough candidates; with no signal the basis is the catalogue ranking. Quality checks (cold start stays near the top of the ranking, a liked tag shifts the list toward it, the shipped method beats the baselines at hit@10) are printed but only `--min-hit10` fails the run.

**Caveat that matters.** A place's category is part of the text its vector is made from, so this protocol favours the vector methods by construction, and it rewards a list that concentrates on the profile's category (which is what a hidden place of that category is). It shows the taste signal is picked up and the diversity and exclusion rules work; it does not show real groups would like the suggestions. Only live votes can.

**Numbers on the real catalogue** (the 2026-11-22 bundle, 8,000 places, with its real BGE-M3 8-bit vectors, 1,024 dimensions; the 20 cities with the most places (Beijing 238, Tokyo 231, Bali 193, Hanoi 193, Ho Chi Minh City 153, Shanghai 145, Seoul 142, Hong Kong 135, and so on down to 99); 160 synthetic group profiles and **960 leave-one-out cases**; seed 20261125, so a rerun gives the same table; `pnpm eval:recommend --bundle ... --embeddings ... --max-cities 20 --sweep`, about 25 minutes on a laptop, progress on stderr):

| method | hit@1 | hit@5 | hit@10 | MRR@20 | categories in top 10 | share of top 10 in the profile's categories | redundancy |
|---|---|---|---|---|---|---|---|
| **group taste + MMR (shipped)** | 0.072 | 0.127 | **0.168** | 0.100 | 8.99 | 0.222 | 0.559 |
| group taste, no diversity | 0.072 | 0.323 | 0.523 | 0.197 | 3.24 | 0.724 | 0.635 |
| average taste only (+MMR) | 0.072 | 0.127 | 0.171 | 0.100 | 9.04 | 0.216 | 0.565 |
| nearest liked place only (+MMR) | 0.071 | 0.123 | 0.165 | 0.098 | 8.83 | 0.237 | 0.550 |
| baseline: catalogue rank | 0.010 | 0.054 | 0.113 | 0.039 | 4.56 | 0.171 | 0.536 |
| baseline: notability | 0.007 | 0.032 | 0.064 | 0.024 | 6.33 | 0.092 | 0.529 |
| baseline: random | 0.016 | 0.047 | 0.077 | 0.034 | 7.58 | 0.119 | 0.510 |

Sweep on the same cases (everything else as shipped):

| setting | hit@5 | hit@10 | MRR@20 | categories in top 10 | share in profile categories | redundancy |
|---|---|---|---|---|---|---|
| **shipped: lambda 0.7, category charge 0.04** | 0.127 | 0.168 | 0.100 | 8.99 | 0.222 | 0.559 |
| lambda 0.5 / 0.6 / 0.85 / 0.95 | 0.091 / 0.097 / 0.156 / 0.168 | 0.100 / 0.135 / 0.214 / 0.238 | 0.085 / 0.091 / 0.116 / 0.121 | 9.81 / 9.41 / 8.29 / 7.78 | 0.145 / 0.184 / 0.277 / 0.313 | 0.499 / 0.536 / 0.584 / 0.596 |
| category charge 0 / 0.01 / 0.02 / 0.08 | 0.292 / 0.220 / 0.170 / 0.094 | 0.488 / 0.315 / 0.231 / 0.113 | 0.185 / 0.143 / 0.121 / 0.086 | 4.18 / 6.71 / 7.91 / 9.73 | 0.672 / 0.420 / 0.312 / 0.153 | 0.601 / 0.578 / 0.568 / 0.553 |
| lambda 0.85, charge 0 / 0.02 | 0.328 / 0.216 | 0.522 / 0.315 | 0.196 / 0.140 | 3.61 / 6.96 | 0.716 / 0.391 | 0.623 / 0.596 |
| average-taste share 0.25 / 0.75 | 0.118 / 0.127 | 0.167 / 0.160 | 0.097 / 0.096 | 8.93 / 9.00 | 0.229 / 0.221 | 0.555 / 0.563 |

Checks, all on the real vectors: **0 of 19,200 suggestions** already planned, voted, commented on or the group's own (must be 0); **19,200 of 19,200** have a reason (cold start 100%); 19,193 of 19,193 "similar to" reasons name a liked place with the right voters and plan; no reason shows a number or credits a model; the 137 sampled cases are repeatable in any row order; every list is full when there are enough candidates. Cold start with no signal: all 20 cities use `catalogue_rank`, 99.5% of the picks are in the catalogue's top 30 and 83% of its top 10 are kept (diversity swaps some out); with one liked tag from elsewhere, 45.5% of the top 10 carry it, against 3.5% without.

**What is real and what is not.** Real: the 8,000 places, their categories, ranks, tags, enrichment and BGE-M3 vectors, and the scoring code (the API's own function). **Synthetic: every group.** Nobody voted. A profile is "this group likes one or two categories in this city", six liked places are sampled from those categories, three simulated members vote them up at random and about a third are planned; then one liked place is hidden and the rest are the signals. Of the seeded trip's 163 planned ideas, 46 are adopted into a catalogue place with a vector in this bundle, but they are spread thinly over many stops (one to three planned per stop, no votes), so a leave-one-out on the seeded trip itself was not run.

**What the real numbers say.**

- The taste signal beats the three baselines at every depth: hit@10 0.168 against 0.113 for the catalogue's own rank, 0.077 for random and 0.064 for notability, hit@1 0.072 against 0.010 to 0.016. Hit rates are low in absolute terms because a hidden place has to beat about 100 to 230 other places and ten slots, and most cities hold many places of the profile's categories that the simulation did not make liked.
- **The shipped diversity settings look too strong on real vectors.** Without the category charge, hit@10 is 0.488 instead of 0.168 and the share of the top 10 in the profile's categories is 0.67 instead of 0.22; with the charge, a group that voted only for temples sees about two temples in ten suggestions. On BGE-M3 the similarity gaps between places of one city are small, so a charge of 0.04 per earlier pick in a category and the 0.3 weight on redundancy outweigh relevance quickly. The 0.04 was chosen before real vectors existed and it sits at the diverse end: 9.0 categories in ten, close to a random list's 7.6.
- **This protocol cannot say what the right setting is.** The hidden place is always in the profile's categories, so the protocol rewards concentration by construction (no charge scores best), while the diversity columns reward the opposite. A group that likes temples may well want one museum among ten suggestions; hit rate on hidden temples cannot tell. The sweep shows the trade, not a clearly better setting: charge 0.01 gives hit@10 0.315 with 6.7 categories, charge 0.02 gives 0.231 with 7.9, lambda 0.85 with no charge gives 0.522 with 3.6. **The shipped constants were not changed.** Lowering the charge to somewhere between 0.01 and 0.02 is the change to consider, and it should be judged on how real groups react to the lists, which only live votes can show.
- Averaging the liked places or taking only the nearest one scores the same as the blend (0.171 and 0.165 against 0.168); on real vectors the blend's share (0.5) makes no measurable difference. The blend stays because it handles a group that likes two kinds of place without a rule.
- "Both kinds present" (a group liking two categories gets both in the top 10) is 1.000 with the shipped settings against 0.849 without diversity: the one place the diversity is clearly earning its cost.
- The 0.45 cutoff for naming a liked place ("close") was not tested apart from the 100% truthfulness check (every named place is one the group really liked); whether 0.45 is the right threshold on BGE-M3 is unmeasured, and the check does not read the wording for how convincing it is.

A plumbing run on the checked-in golden bundle with fake hashing vectors (`pnpm eval:recommend`, 80 places, 60 cases) is what the tests use: it checks the code, not the model, and gives shipped hit@10 0.600 against 0.517 for the catalogue's rank, 0.450 notability and 0.300 random. Do not read those figures as quality.

### Tests and what was not run

- `apps/api/test/recommend-unit.test.ts` (no database): signals and member balancing, taste and dislikes, scoring, MMR, cold start, the reason text for each case, the request schema, the eval engine's invariants and determinism.
- `apps/api/test/recommend.test.ts` (both databases in CI): a real bundle loaded with fake vectors; cold start in a stop added in Nagoya (no seeded idea there is planned in any route); liked-by-plan-only in the seed's Saigon stop (`liked: 2, members: 0`, `no_taste`); a vote drives the top suggestion and the reason is worded for the member asking ("you voted for", "one of you voted for", "2 of you voted for"); planned (in any route), voted, commented-on places are never suggested; the enrichment filters; limits; viewers 200, strangers 404, signed-out 401, the demo account 200 with **no embedder call**; the same suggestions for another route's stop in the same city; before any vectors are loaded.
- `apps/web/e2e/recommend.spec.ts`: the drawer panel with the golden bundle and the fake vectors the e2e already loads: the voted temple's neighbours come first with "Similar to ..., which you voted for", every card has a reason and its source and licence, "Add to ideas" and "Plan here" move the place out of the suggestions, the filters, and the loading, error, empty and cold-start states.
- **Status: not run against a database.** Docker would not start on the machine this was written on, so the Cypher (`apps/api/src/repositories/cypher/recommend/`), the integration test and the Playwright spec were written from the existing queries' patterns and typechecked, not executed. CI is the first run. What only CI can settle: that both databases accept `collect({userId: u.id, value: v.value})` over an `OPTIONAL MATCH` (the repository drops the one empty entry an unvoted place gets), the grouped `sum` and `count(DISTINCT a)` in the tag reads, and the order of the e2e's fake-vector neighbours.
- Memory and time: a request reads one city (a few hundred rows) and compares at most a few hundred 1,024-dimension vectors with each other: milliseconds. The vectors are the search service's matrix (33 MB for 8,000), loaded on first use and shared, not a second copy.

## Running it in Cloud Run (nothing here is created by the code)

The job is the API image run with another command. After the one-time setup below, `deploy.yml` keeps its image current and `load-catalogue.yml` runs it, both only when the repository variable `CATALOGUE_LOAD_JOB` is set.

```sh
# Once, by the owner (same network settings as the API so it can reach FalkorDB):
gcloud run jobs create trippr-load-bundle \
  --image "$REGION-docker.pkg.dev/$GCP_PROJECT_ID/trippr/api:latest" --region "$REGION" \
  --command node --args dist/load-bundle.js \
  --network default --subnet default --vpc-egress private-ranges-only \
  --memory 512Mi --task-timeout 600 --max-retries 1 \
  --set-env-vars "DB_DIALECT=falkordb,SCHEMA_DIR=/app/db/schema,DATA_BUCKET=trippr-bucket-data" \
  --set-secrets "FALKORDB_URL=trippr-falkordb-url:latest"
# The job's service account needs roles/storage.objectViewer on the bucket.
```

Then add the repository variable `CATALOGUE_LOAD_JOB=trippr-load-bundle`. Run it by hand with `gcloud run jobs execute trippr-load-bundle --region "$REGION" --wait` (add `--args="dist/load-bundle.js,--dry-run"` for a dry run).

| Setting | Where | Meaning |
|---|---|---|
| `DATA_BUCKET` | pipeline and job | Bucket name; the job reads `gs://$DATA_BUCKET/bundles` |
| `BUNDLE_LOCATION` | job | A folder or `gs://` location instead |
| `EMBEDDINGS_LOCATION` | job | Where the `embeddings/<date>/` runs are; default: `embeddings` next to the bundles folder |
| `CATALOGUE_TRIP_ID` | job | The trip that gets the places when there is more than one |
| `CURATE_BUDGET` | pipeline | Total places in the graph (default 8000) |

## Stay analytics (PR 7)

Feature 5 of the [spec](data-platform-spec.md): where to stay, backed by data. The pipeline half is in [pipelines/README.md](../pipelines/README.md#stay-analytics) (Inside Airbnb aggregates, open-data hotels, the stay score). This is the rest of the path.

```
stay stages ─► bundle (stay_unit, hotels) ─► load job ─► Area stay cards, StayMarket cells, catalogue Hotels ─► API ─► Where to stay drawer, Map tab, Data page
```

**Bundle.** `bundle` writes `stay_unit.jsonl.gz` (one row per city, Area, neighbourhood and H3 cell: aggregates, score parts, `explanation`, `snapshot_date`) and `hotels.jsonl.gz` (hotels inside an Area's radius, at most 150 per Area, with each source record's licence), checksummed in the manifest, whose `stay` section holds the unit counts, covered cities with snapshot dates, coverage ("Inside Airbnb covers 5 of 108 cities"), the score weights and the pipeline's stay check results. Bundle checks add `stay.units.*` and `stay.hotels.*` (unique ids, Areas known to `seed/areas.json`, valid H3 cells, the privacy minimum of 3 listings, licences and registered sources); a failed stay check fails the bundle. Without the stay stages the bundle is what it was and loads as before. Schemas: `pipelines/src/trippr_data/bundle_stay.py` (pydantic), `packages/contracts/src/stay.ts` (zod); the golden bundle carries stay tables from the stay fixtures, and both sides parse it.

**Load job.** After the places, the job puts the stay tables in the graph (`services/catalogue/stay.ts`), all Cypher in `repositories/cypher/stay-data/`, schema statements for both databases in `db/schema/`:

| What | Where |
|---|---|
| Area stay card (parts and weights, explanation, price range, market numbers, distances, snapshot) | `stay` (JSON) plus `stayScore`, `stayMedianPriceCad`, `staySnapshotDate`, `stayBundleDate`, `stayHotelCount`, `stayHash` on the seeded `Area` nodes. Only Areas that exist are touched; an Area missing from the new bundle loses them |
| City summary, H3 cells and neighbourhoods for the map layer | One `(:StayMarket {id: cityCode})-[:FOR_CITY]->(:City)` per Inside Airbnb city, with compact JSON rows `[id, lat, lon, price, pricePerPerson, listings, score, name?]` and a bounding box. About 700 cells for Tokyo, so a few dozen kB per city, not thousands of nodes |
| Open-data hotels | `(:Hotel {catalogue: true})-[:IN]->(:Area)`, `-[:IN_CITY]->(:City)`, `-[:FROM_SOURCE {sourceId, fetchedAt, licence}]->(:DataSource)`, with `areaId`, `kind`, `stars`, `sources`. They have no price, no trip and are never booked |
| Latest stay load (Data page, coverage note) | `(:StayLoad {id: 'latest'})`, only replaced by a bundle that has stay data |

It is idempotent (content hashes; the second run creates nothing). It never reads or changes the group's own hotels (`Hotel` nodes without `catalogue`), stays, bookings, votes or Area text: catalogue hotels have no `FOR` trip, so the hotel list, votes and `STAYS_AT` never reach them, the Areas' `hotelCount` leaves them out, and deleting an Area removes only its suggestions. A hotel the new bundle drops, or whose Area is gone, is removed. A bundle without stay data changes nothing about stay. Area `radiusKm` (default 1.5, editable with `POST`/`PATCH /areas`) is stored on the Area; the stay numbers use the radius the data run used, shown on the card.

**API** (same conventions as the other trip routes: sign-in and at least the viewer role on the trip that owns the Area, 404 for non-members):

| Route | |
|---|---|
| `GET /areas/:id/stay` | The Area's stay card: `availability` (`market`, `places` or `none`), score with its five parts and weights, the explanation, price range (quartiles, median, per person, city median), market numbers, distances, snapshot and bundle dates, `coverage` ("Inside Airbnb covers 5 of 108 cities"), the attribution when listing numbers are used, and one honest `note` |
| `GET /trips/:id/stay/cells` | H3 cells for the map layer: `city` and/or `bbox=minLon,minLat,maxLon,maxLat`, `limit` (default 1500, max 3000), `layer=h3\|neighbourhood`. Returns each city's colour scale (10th to 90th percentile of its cell prices, so colours stay put while panning), `truncated` and the attribution |
| `GET /areas/:id/hotel-suggestions` | Open-data hotels in the Area, best first (more sources, stars, a website, closer), `limit` (30, max 100), each with its sources and licences, plus the attribution lines |
| `GET /data/sources` | Also carries `stay` (coverage, snapshot dates, units, hotel counts, weights, stay checks, attribution) and a `hotels` count on lodging sources |

**Web.** Each Area in a stop's "Where to stay" drawer has a stay card: the score with its parts as labelled bars, the price range, the explanation, snapshot date, coverage note and the CC BY 4.0 credit, or "No stay data for this city" with the coverage note. "Search Airbnb" and "Search hotels" are plain keyword searches built from the Area, the stop's dates and the group size (`stayLinks` in `packages/rules`): no scraping, no affiliate or tracking parameters, nothing about individual listings. "Hotels from open data" lists the suggestions with an "Add" button that copies a name, link and pin into the group's own hotel list. The Map tab has a "Stay prices" toggle: H3 hexagons on a light-to-dark sequential scale per city, a legend with each city's price range and snapshot, a click card for a hexagon, and the attribution. The Data page has a "Stay analytics" section: coverage, snapshot dates by city, unit and hotel counts, the weights, the attribution text and the stay check results.

**Privacy and licences.** Inside Airbnb is CC BY 4.0: aggregates only. Units under 3 listings carry no statistics and are not published as cells; neither the bundle schema (`strict`) nor the graph has a field for a listing id, host id, name or link. Open-data hotels keep their source licences (OpenStreetMap lodging is ODbL, shown with attribution).

**Not run where this was written.** The Cypher in `stay-data/` and the integration tests (`apps/api/test/stay.test.ts`, both databases) were checked by reading and by the unit tests; CI is the first real run against FalkorDB and Neo4j. The Playwright specs (`apps/web/e2e/stays.spec.ts`) load the golden bundle with the real load job, so they exercise the same path.
