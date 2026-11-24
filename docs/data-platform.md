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
- **Input**: `matched/<date>/golden.parquet`, the match stage's output; `pipelines/src/trippr_data/golden.py` lists the columns curate reads from it (names, coordinates, Wikidata sitelinks, Wikivoyage listing, confidence, `sources[]`). Without it, curate treats each staged row as its own golden record, merging only same-name rows of two sources within 75 m (`provisional.py`, to be deleted when matching runs in every run).
- **Ids** are stable: `cat-` plus a hash of the place's Wikidata QID, else of its best source record. The load job also matches by source record, so an id that changes when clusters change does not lose votes.
- Every place keeps the list of source records it was built from, each with its licence.

## Bundle

`python -m trippr_data bundle` writes `bundles/<date>/`:

| File | What |
|---|---|
| `places.jsonl.gz` | One curated place per line, ordered by city and rank. What the load job reads |
| `places.parquet` | The same places for DuckDB and BigQuery |
| `sources.json` | The registry entries behind the places: licence, attribution, terms date, counts, freshness |
| `manifest.json` | Counts, file checksums (SHA-256) and the check results |

The JSON shapes are defined twice, in `pipelines/src/trippr_data/bundle.py` (pydantic) and `packages/contracts/src/catalogue.ts` (zod). The pipeline's golden test writes a bundle from the fixtures and commits it (`pipelines/tests/fixtures/expected/bundle/`); the contract tests, the API integration tests and the e2e tests all read that same bundle, so the two sides cannot drift.

Bundle checks (any failure sets `checks.passed: false`, so the bundle is never loaded): non-empty; unique ids; every place has sources and a licence for each, all listed in `sources.yaml`; categories in the taxonomy; coordinates inside the city radius and the country box; no two places with the same name within 50 m; within the budget, floor and cap; no colour tag far above its share; plus the staging checks of the same run.

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

Activity gains `catalogue`, `category`, `score`, `rank`, `listed`, `nameLocal`, `phone`, `openingHours`, `wikidataQid`, `sources` (JSON of source id, record id and licence), `sourceKeys`, `sourceIds`, `catalogueId`, `contentHash`, `bundleDate`. `(:Activity)-[:FROM_SOURCE {sourceId, fetchedAt, licence}]->(:DataSource {id, name, licence, url, attribution, ...})` makes licences queryable. Constraints and indexes are in `db/schema/*.cypher`; the job applies them first, and they are idempotent.

### API

| Route | |
|---|---|
| `GET /trips/:id/activities/page` | The whole library, filtered and paged: `scope` (`all`, `mine`, `catalogue`), `city`, `tag`, `category`, `q`, `source`, `minScore`, `maxRank`, `fixedDates`, `sort`, `offset`, `limit` (50, max 100). Viewers can read it |
| `GET /trips/:id/activities/facets` | Filter menus and headline numbers |
| `GET /trips/:id/activities` | Unchanged for existing callers: the group's own ideas, plus catalogue places it voted on, commented on or planned |
| `GET /data/sources` | Public. Sources with licences and attribution, counts, freshness, the latest load and its checks |

The stop drawers and the route editor's library show catalogue places only once the group has engaged with them, so a city's few hundred places do not bury its ideas.

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
| `CATALOGUE_TRIP_ID` | job | The trip that gets the places when there is more than one |
| `CURATE_BUDGET` | pipeline | Total places in the graph (default 8000) |
