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
