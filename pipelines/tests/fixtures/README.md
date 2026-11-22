# Test fixtures

Small, checked-in inputs for the offline tests. Nothing here is downloaded at test time.

| Path | What it is |
|---|---|
| `data/raw/overture/2026-11-18/{TYO,OSA}.parquet` | 300 real Overture Places rows (release `2026-11-18.0`) sampled from the Tokyo and Osaka bounding boxes, in the exact shape `extract` writes |
| `data/raw/foursquare/2026-11-18/{TYO,OSA}.parquet` | 46 Foursquare-schema rows. **Partly synthetic**, see below |
| `data/raw/*/2026-11-18/_meta.json` | Manifests like the ones `extract` writes, with a fixed fetch time |
| `expected/staged_place.csv`, `expected/summary.json` | Golden output of stage + check on the fixtures (`tests/test_golden.py`) |
| `make_fixtures.py` | Rebuilds `data/` from a real local extract: `uv run python tests/fixtures/make_fixtures.py --raw out/raw/overture/<date>` |

## How the rows were chosen

`make_fixtures.py` takes, for each city, up to 7 places per Overture top-level category, up to 2 places
for each of about 30 categories that matter to Trippr (temples, shrines, museums, parks, onsen, viewpoints
and so on), a few places with English name rules, permanently closed places, and the 3 places nearest the
south-west corner of the bounding box (outside the 25 km circle). The choice is deterministic (ordered by a
hash of the id).

## The Foursquare fixture

Foursquare's official copies need an account (see `pipelines/sources.yaml`), so the pipeline has never
downloaded Foursquare data. The Foursquare fixture is built from the sampled Overture rows whose
`sources` credit Foursquare (Overture redistributes them under Apache 2.0): the id is Foursquare's own
record id from Overture's `sources[].record_id`, and the name, coordinates, address, phone and website
are the Overture values. The rest is synthetic:

- `fsq_category_labels` are assigned by `make_fixtures.py` from the Overture category (unknown ones get
  `Landmarks and Outdoors > Structure`, which is deliberately unmapped).
- `fsq_category_ids` are the placeholder `fixture`; `date_refreshed` is a fixed date.
- Edge cases: one place marked closed, one place repeated in both city files, and one row
  (`fixture-wrong-country`) moved to central Tokyo with country `KR`.

## Attribution and licences

- **Overture Maps Places**, release 2026-11-18.0, © Overture Maps Foundation, overturemaps.org. Each row
  keeps its provider's licence in `sources[].license`: CDLA Permissive 2.0 (Meta, Microsoft and others),
  Apache 2.0 (Foursquare: Copyright 2024 Foursquare Labs, Inc. All rights reserved) and CC0 1.0
  (AllThePlaces). See https://docs.overturemaps.org/attribution/.
- The Foursquare-schema rows derive from the Foursquare records above and are used under Apache 2.0
  (https://www.apache.org/licenses/LICENSE-2.0).
