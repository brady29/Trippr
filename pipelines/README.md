# Trippr data pipeline

Python package that turns open place datasets into one clean, checked table of places for Trippr's
108 cities. This is PR 1 of the [Trip Data Platform Spec](../docs/data-platform-spec.md): extract and
stage **Overture Maps Places** and **Foursquare Open Source Places**, run quality checks and write a
run report. Matching, curation, enrichment and loading into the graph come in later PRs.

```
extract ─► raw/<source>/<date>/<CITY>.parquet + _meta.json
stage   ─► staging/<date>/<source>.parquet (staged_place) + <source>.stats.json
check   ─► reports/<date>.checks.json        (exit 1 on a failed check)
report  ─► reports/<date>.md + <date>.json   (+ $GITHUB_STEP_SUMMARY, + latest.json when passed)
upload  ─► gs://$DATA_BUCKET/...             (same layout)
```

## Running it locally

Needs Python 3.12 and [uv](https://docs.astral.sh/uv/) (`pip install uv` works too).

```sh
cd pipelines
uv sync                                   # creates .venv from uv.lock
uv run python -m trippr_data extract --source overture --cities TYO,OSA,CKG
uv run python -m trippr_data stage        # defaults to the newest raw date
uv run python -m trippr_data check
uv run python -m trippr_data report       # prints the report path

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
| `FSQ_PLACES_PATH`, `HF_TOKEN`, `FSQ_S3_REGION` | extract | Where to read Foursquare from (see below) |
| `TRIPPR_DATA_OUT` | all | Output root instead of `pipelines/out/` |

## Layout

| Path | What |
|---|---|
| `sources.yaml` | Source registry: name, URL, licence, attribution, terms checked on, allowed uses, enabled. A source without an entry (or disabled) is refused |
| `config/taxonomy.csv` | Trippr's 33 place categories, each with one of the app's colour tags (sport, tech, nature, culture, food) or `other` |
| `config/category_map_overture.csv` | Overture taxonomy label → Trippr category (or `exclude`) |
| `config/category_map_foursquare.csv` | Foursquare label path → Trippr category (or `exclude`) |
| `config/city_radius.csv` | Per-city radius overrides (small towns and islands at 10 km, Macau at 10 km) |
| `config/countries.csv` | Country bounding boxes (for the coordinate check) and local languages (for `name_local`) |
| `src/trippr_data/` | `extract/` (one module per source), `stage.py`, `checks.py`, `report.py`, `storage.py`, `cli.py` |
| `tests/` | pytest; `tests/fixtures/` holds the two-city fixtures and the golden output |

Cities come from `../seed/cities.json` (not modified). Each city's area is a circle of its radius; the
extract uses the circle's bounding box and staging keeps a place only if it is within the radius of its
nearest city. When a place's address names a country, cities in that country are preferred, so a
Shenzhen shop does not land in Hong Kong and a Zhuhai shop is not counted as Macau.

## staged_place

| Field | Notes |
|---|---|
| `source`, `source_id` | `overture` + GERS id, `foursquare` + `fsq_place_id` |
| `name`, `name_local`, `name_en` | `name` is the source's primary name after NFKC normalisation (full-width Latin → ASCII, half-width katakana → full-width, whitespace collapsed, separator punctuation trimmed). Scripts are kept: `name_local` is the name in one of the country's languages (Overture name rules) or the primary name when it is not Latin script; `name_en` is the English name rule or the primary name when it is Latin script |
| `category_source`, `category` | The source's own category and Trippr's |
| `lat`, `lon`, `city_code` | WGS84; the nearest Trippr city within its radius |
| `address`, `website`, `phone`, `opening_hours` | When the source has them (neither source has opening hours) |
| `wikidata_qid` | Empty for now: Overture places have no place-level QID (only a brand QID, kept in `signals.brand_wikidata`); OSM and Wikivoyage fill it in PR 2 |
| `signals` | `confidence` (Overture), `providers` (Overture's upstream datasets), `brand_wikidata`; `wikidata_sitelinks` and `wikivoyage_listed` arrive in PR 2 |
| `licence`, `fetched_at`, `raw_ref` | Per-record licence (Overture's `sources[].license`), fetch time and the raw file it came from |

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

### Foursquare Open Source Places (disabled)

Apache 2.0, but as of 2026-11-22 the official copies need an account: the Foursquare Places Portal
(account + access token for its Iceberg catalog) or the gated Hugging Face dataset (log in and accept
its conditions). The old public S3 bucket no longer serves the Parquet files. The pipeline does not sign
up or accept terms, so the extractor reads whatever Parquet glob the owner provides. To enable it:

1. Get access (Hugging Face: accept the conditions on
   https://huggingface.co/datasets/foursquare/fsq-os-places and create a read token).
2. Set `FSQ_PLACES_PATH`, e.g.
   `hf://datasets/foursquare/fsq-os-places/release/dt=2026-11-17/places/parquet/*.parquet`, and
   `HF_TOKEN` (locally, and as repository secrets for the workflow).
3. Set `enabled: true` for `foursquare` in `sources.yaml`, run
   `uv run python -m trippr_data extract --source foursquare --cities TYO`, and review the unmapped
   categories in the report against `config/category_map_foursquare.csv` (written from Foursquare's
   published taxonomy, not yet checked against live data).

## Scheduled runs

`.github/workflows/data-pipeline.yml` runs monthly (and on demand) once the `DATA_BUCKET` repository
variable exists. It signs in to Google Cloud with workload identity federation (the same
`GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT` as `deploy.yml`), runs
`run --cities all`, uploads to the bucket and puts the report in the run summary. A failed check
fails the workflow; the data is still uploaded for inspection, but `reports/latest.json` (the next
run's baseline) only moves on a passed run.

One-time setup for the owner (nothing here is created by the code):

```sh
gcloud storage buckets create gs://trippr-data --project "$GCP_PROJECT_ID" --location us-central1 \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding gs://trippr-data \
  --member "serviceAccount:$GCP_SERVICE_ACCOUNT" --role roles/storage.objectAdmin
```

Then add the repository variable `DATA_BUCKET=trippr-data`.
