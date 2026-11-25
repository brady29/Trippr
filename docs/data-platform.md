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
| `manifest.json` | Counts, file checksums (SHA-256) and the check results; `enrichment` and `evals.enrich` when the bundle is enriched |
| `enrichment.jsonl.gz`, `enrichment.parquet` | Optional. The LLM enrichment (see below), one line per enriched place, joined to the places by id |

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
