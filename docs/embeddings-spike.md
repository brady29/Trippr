# Embeddings spike: model, hybrid query path, vector index

Nov 24, 2026 · PR 5, pipeline half · feeds [Feature 4 of the data platform spec](data-platform-spec.md)

This answers the spec's open question 2 (local or hosted embeddings) for the **hybrid** setup the owner chose:
place vectors computed on a laptop in batch, only the short search query embedded at request time by a
small hosted call or tiny service, so the 512 MiB Cloud Run API never loads a model.

## Summary

| Question | Answer |
|---|---|
| Which model? | **BGE-M3** (`BAAI/bge-m3`, 1024 dims). On the 8,000-place bundle it beats `multilingual-e5-small` by 30% MRR (0.67 against 0.52) and by 45% recall@10 (0.56 against 0.39), most of it on Japanese, Chinese and Vietnamese queries and on place names. |
| Can the place vectors be made locally? | Yes. About 24 minutes for all 8,000 places on 4 CPU threads with the 8-bit ONNX build (5.6 places/s; 53 minutes with PyTorch), once a month or when places change; a content-hash cache means later runs only embed what changed. Needs about 1.4 GB of memory. No GPU, no PyTorch. |
| Can the query be embedded hosted? | Yes, **only if the hosted service serves the same model.** Cloudflare Workers AI serves `@cf/baai/bge-m3` for $0.012 per million tokens with a free 10,000 neurons a day (about 9 million tokens), so search costs nothing at this scale. A parity check (`eval/search/parity_check.py`) must pass before the app uses it: the cosine between the local and the hosted vector of the same query must be above 0.98. It has **not been run**: no hosted account exists and nothing was spent. |
| What if no hosted service is acceptable? | A tiny Cloud Run service running the same model (BGE-M3 8-bit ONNX, 570 MB), or the `multilingual-e5-small` fallback (see "Options"). |
| What breaks it? | A query vector from a different model. Measured: place vectors from E5-small queried with another 384-dimension model give MRR 0.007 (chance), against 0.517 with the right model. The manifest records the model; the loader and the API must compare it before use. |

## What was measured

### The labelled sets

Written for this spike, in `pipelines/eval/search/`. Every query is judged against a corpus by exact
rules, and `trippr-data eval-search` reproduces the numbers (recall@k, success@k, MRR, NDCG@10, by query
kind and language, brute-force cosine as the reference).

| Set | Corpus | Queries | Notes |
|---|---|---|---|
| **Bundle** (`queries_bundle.yaml`) | the curated bundle `places.parquet`: 8,000 places, 108 cities, English and local names, a Wikivoyage or Wikidata description for 62% | 89: 41 names, 24 categories, 12 intents, 12 descriptions; English 38, Chinese 18, Vietnamese 11, Japanese 9, Korean 7, Thai 6 | The main result. The corpus is not checked in (it is a build output); labels are rules over its columns (city, English name, category, a regex on the description), so they survive a re-curation. Description labels are approximate by nature (a regex), so their recall is understated. |
| **Staged** (`queries.yaml`, `places.csv`) | 2,263 places drawn from the staged Overture and Foursquare rows (names and categories only, no descriptions), including 31 landmarks that appear under several names and scripts | 68: 32 names, 24 categories, 12 intents; the same six languages | Checked in, so the eval runs without the bundle and in CI with the fake embedder. Easier: small corpus, one name per record. |

A name query is a well-known place asked for in a language or romanisation the record's primary name
does not use ("센소지" for Sensō-ji, "东京塔" for Tokyo Tower, "Lama Temple Beijing" for Yonghe Temple).
A category query is "temples in Kyoto" in Japanese, Thai and so on, answered by the city's places in that
category. The limits: 12 to 41 queries per kind and 6 to 38 per language are small, so differences under
about 0.05 MRR are noise; the labels are mine, not a panel's; the eval has no judgments on the *ranking
quality among relevant places* beyond what the metrics show.

### Models (bundle set, 8,000 places, 89 queries, 4 CPU threads, this Windows laptop)

| Model | Dims | MRR | Success@1 | Recall@10 | NDCG@10 | Place embedding | Query (1 text, warm) | Memory loaded / peak |
|---|---|---|---|---|---|---|---|---|
| fake hashing baseline (lexical) | 384 | 0.201 | 0.157 | 0.178 | 0.166 | 1,200/s | 0.1 ms | 80 MB |
| `paraphrase-multilingual-MiniLM-L12-v2` (PyTorch) | 384 | 0.355 | 0.281 | 0.220 | 0.250 | 26/s | 22 ms | 1.1 / 1.3 GB |
| `multilingual-e5-small` (ONNX fp32) | 384 | **0.517** | 0.461 | 0.386 | 0.415 | 29/s (4.6 min) | 6.8 ms | 0.8 / 1.0 GB |
| `multilingual-e5-small` (ONNX 8-bit) | 384 | 0.506 | 0.449 | 0.385 | 0.407 | 50/s (2.7 min) | 4.4 ms | 0.5 / 1.0 GB |
| `multilingual-e5-base` (PyTorch) | 768 | 0.594 | 0.517 | 0.431 | 0.467 | 8.4/s (16 min) | 48 ms | 1.8 / 2.2 GB |
| **`bge-m3`** (PyTorch) | 1024 | **0.673** | **0.584** | **0.558** | **0.588** | 2.5/s (53 min) | 153 ms | 1.9 / 2.4 GB |
| **`bge-m3` (ONNX 8-bit)** | 1024 | **0.680** | 0.584 | 0.563 | 0.594 | 5.6/s (24 min) | 20.6 ms | 0.9 / 1.4 GB |

Single-process memory numbers include about 60 MB of Python and DuckDB. The "peak" column for ONNX
Runtime includes its arena allocator and is higher than the model file suggests. On a 12-thread laptop the
batch is faster than the 4-thread figures (the 4 threads mimic a GitHub runner); that was not measured
cleanly because other work was running.

By kind and language (MRR; the bundle set):

| | name (41) | category (24) | intent (12) | description (12) | en | ja | zh | ko | vi | th |
|---|---|---|---|---|---|---|---|---|---|---|
| E5-small fp32 | 0.45 | 0.60 | 0.60 | 0.49 | 0.86 | 0.17 | 0.17 | 0.17 | 0.32 | 0.67 |
| E5-base | 0.46 | 0.67 | 0.74 | 0.75 | 0.89 | 0.24 | 0.22 | 0.57 | 0.34 | 0.83 |
| BGE-M3 | **0.72** | 0.55 | 0.79 | 0.65 | 0.86 | **0.41** | **0.81** | 0.23 | **0.56** | 0.24 |

Reading it:

- **All models are good at English** (0.86 to 0.89). The spread is in the other languages, which is the
  point of a Japan, China, Korea, Vietnam and Thailand trip.
- **E5-small is weak on Chinese and Japanese queries** (MRR 0.17 for both). BGE-M3 gets Chinese to 0.81,
  Japanese to 0.41 and names overall to 0.72, with recall@10 on name queries of 0.88 against 0.54.
- **BGE-M3 is not best everywhere.** On Thai and Korean the E5 models win (the Thai and Korean query
  counts are 6 and 7, so treat those two columns as hints), and E5-base is better on category queries.
- **The 8-bit E5-small loses almost nothing** (MRR 0.506 against 0.517), so a quantised copy is fine.
- The staged set, where each landmark has several records and names are easier, ranks the models the same
  way: E5-small 0.81, E5-base 0.85, BGE-M3 0.89 (MRR).

### The hybrid, measured

Place vectors from one build of a model, queries from another (bundle set, E5-small):

| Place vectors | Query vectors | MRR | Recall@10 |
|---|---|---|---|
| E5-small fp32 | E5-small fp32 | 0.517 | 0.386 |
| E5-small fp32 | E5-small **8-bit** | 0.487 | 0.381 |
| E5-small 8-bit | E5-small fp32 | 0.510 | 0.391 |
| E5-small fp32 | **a different 384-dim model** (MiniLM) | **0.007** | 0.001 |
| BGE-M3 fp32 (PyTorch) | BGE-M3 **8-bit** (ONNX) | 0.682 | 0.554 |
| BGE-M3 8-bit | BGE-M3 8-bit | 0.680 | 0.563 |

So the queries must come from the same model; a quantised build of it costs about 6% MRR for E5-small in
one direction and nothing in the other, and **nothing for BGE-M3** (0.682 with fp32 places and 8-bit
queries against 0.673 all fp32). That tolerance is what makes a hosted copy of the weights, whose numerics
may differ a little, safe to use. A different model gives noise. `trippr-data embed` records the
model, the exact weights version (`intfloat/multilingual-e5-small/onnx/model.onnx@614241f622f5`) and the
dimensions in `manifest.json`, so a mismatch can be detected rather than guessed.

### Query time (what the hosted path has to provide)

A search query is a few to 30 tokens. Measured, one query at a time, warm:

| Where | Model | Latency p50 / p95 | Memory | Notes |
|---|---|---|---|---|
| Node, `@huggingface/transformers` 4.3.2 (ONNX Runtime) | E5-small 8-bit | 21 / 46 ms | process 460 MB (57 MB bare Node) | first load 2 s from a warm disk cache, 9 s with the download |
| Node | E5-small fp32 | 9 / 13 ms | process 770 MB | load 15 s |
| Python, ONNX Runtime | E5-small 8-bit | 4.4 / 5.3 ms | process 490 MB | |
| Python, ONNX Runtime | BGE-M3 8-bit | 21 / 26 ms | process 0.94 GB loaded (1.4 GB at the batch peak) | 4 threads, 25 s load; this is what the tiny service would run |
| Python, PyTorch | BGE-M3 fp32 | 153 / 174 ms | process 1.9 GB | 4 threads, 26 s load |
| Hosted (Cloudflare Workers AI, BGE-M3) | | not measured; no account | none in the API | one HTTPS call, typically tens of ms to a few hundred; the parity check also prints latency once run |

The API runs with `--memory 512Mi`, so **even the smallest model in the API process does not fit**
(E5-small 8-bit needs about 400 MB more than Node itself). A hosted call or a separate service is needed;
the hybrid answers that.

## Options for the query path

All have to serve the *same weights* the places were embedded with. Costs are estimates from published
price pages read on Nov 24, 2026; confirm before turning anything on.

| Option | Place vectors | Query path | Quality (bundle MRR) | Cost | Cons |
|---|---|---|---|---|---|
| **A. BGE-M3 local, Cloudflare Workers AI for queries** (recommended) | BGE-M3 on the laptop, 1024 dims, 33 MB | `@cf/baai/bge-m3` over HTTPS from the API | 0.67 | Free tier covers it: 10,000 neurons a day is about 9 million tokens at 1,075 neurons per million, and the whole group makes a few hundred queries a day (about 10,000 tokens). Above the allowance $0.012 per million tokens | Needs a Cloudflare account and an API token in Secret Manager (a new vendor); the hosted weights must match (parity check); one more network hop and a third party seeing the query text. Place vectors cannot be recomputed in CI |
| **B. BGE-M3 local, tiny Cloud Run service for queries** | same | A separate container (`trippr-embed`) with BGE-M3 8-bit ONNX (570 MB), 2 GiB, 1 vCPU, called by the API | 0.68 measured (8-bit, no loss) | Scale to zero: free within Cloud Run's free tier, but a **cold start of 10 to 30 s** on the first search of a session. `--min-instances 1` removes it for roughly **$19 a month** (1 vCPU and 2 GiB at idle rates of about $0.0000075 a second; the Cloud Run price page could not be read in full, so this uses remembered rates) | The cost and the cold start; another image to build and deploy; the API must reach it (Direct VPC or public with auth) |
| **C. E5-small local, 8-bit in a tiny service** | E5-small, 384 dims, 12 MB, 5 minutes to compute | A small service (or Cloudflare Workers/transformers.js) with the 118 MB model | 0.52 | 1 GiB service: about half of B's idle price | Weak on Chinese and Japanese queries |
| **D. Hosted for both sides** (Voyage `voyage-4-lite`, Vertex `text-multilingual-embedding-002`, Cloudflare BGE-M3) | the provider embeds the 8,000 places | the same provider | **not measured** (no spend) | One-off: the bundle is 398,000 E5 tokens (1.46 million characters), so about $0.008 at Voyage's $0.02 per million (200 million free tokens), $0.005 at Cloudflare, about $0.04 at Vertex's $0.000025 per 1,000 characters | Needs a key in the pipeline workflow; changing provider or model means re-embedding; place vectors depend on a vendor. Cheap enough that measuring it on the same 89 queries costs under 5 cents, if the owner approves |

What the owner has to approve or set up for A: a Cloudflare account (free plan is enough) and an API
token with the Workers AI permission, stored as a secret, never in the repo. Nothing in this PR calls it.
If Cloudflare's BGE-M3 returns vectors that differ from the local ones (different precision or
normalisation), the parity check fails and the fallback is B.

The reason for choosing a model that is **hosted by someone else and runnable locally** is exactly the
hybrid's constraint. Of the models measured, `bge-m3` is the one that is (a) clearly the best, (b) cheap
to embed on a laptop once a month, and (c) offered as a hosted endpoint. E5-small is the cheapest to
self-host but is the weakest of the three on the languages the trip needs; E5-base is not offered
hosted by the providers checked and takes 16 minutes to embed with no change in the query-path problem.

## Recommendation

1. **Model: BGE-M3, 1024 dimensions.** Place vectors computed with `trippr-data embed` (default model
   `bge-m3-q8`, the 8-bit ONNX build; `bge-m3` is the fp32 ONNX reference) on the laptop, monthly. The place text already
   carries both scripts and the Wikivoyage description, which is where BGE-M3's lead is largest.
2. **Query path: option A**, with **B as the fallback** if the parity check fails or the owner would rather
   not add a vendor. Both use the same weights; the API reads the model name and dimensions from the
   embeddings manifest and refuses to search if its configured query model differs.
3. **Keep E5-small as the zero-vendor fallback** (option C) and the CI-sized model: it is in the model table
   and works through the same stage.
4. Settings (spec "Settings"): `EMBEDDINGS=local|hosted` becomes `EMBEDDINGS_QUERY=cloudflare|service|off`
   plus the model name from the manifest; the keys live in Secret Manager.

Decision for the owner: A needs a Cloudflare account; B costs about $19 a month for no cold start
(or free with one). I would start with A, gated by the parity check, and measure option D on the same labelled
queries only if wanted (under 5 cents, needs approval).

## The embed stage and the eval (what was built)

- `trippr-data embed [--input FILE] [--model NAME]`: reads the bundle's `places.parquet` (any Parquet,
  glob or CSV with the columns in `embed/inputs.py`), builds "names (every script) · category label ·
  city · summary · description", embeds in batches, caches by content hash
  (`sha256(model, weights version, text version, text)`), and writes `embeddings/<date>/embeddings.parquet`
  (`place_id`, `content_hash`, `vector`) with a `manifest.json`.
- `trippr-data eval-search`: the labelled queries against an embeddings run, with `--min-mrr` and
  `--min-recall10` gates and a JSON report.
- `eval/search/model_spike.py` (this document's numbers), `parity_check.py` (the hosted gate),
  `build_corpus.py` (how the staged corpus was drawn).
- Models: `fake` (offline tests), `multilingual-e5-small[-q8]`, `bge-m3[-q8]` via ONNX Runtime (the `embed`
  extra: onnxruntime, tokenizers, huggingface-hub; no PyTorch), and `st-*` via sentence-transformers for
  the spike only.

## Vector index design (not implemented here)

Versions in `docker-compose.yml` and CI: **FalkorDB v4.22.1** and **Neo4j 5.26 Community**. Syntax below
is from each vendor's current documentation; **it was not executed**, because Docker Desktop on the
machine this was written on would not start (a stale socket in its data folder). The first thing the app
half does is run each statement in the existing integration harness, which covers both databases.

| | FalkorDB 4.22 | Neo4j 5.26 |
|---|---|---|
| Since | vector indexes arrived in 4.0 | beta 5.11, GA 5.13 |
| Create | `CREATE VECTOR INDEX FOR (n:Activity) ON (n.embedding) OPTIONS {dimension: 1024, similarityFunction: 'cosine'}` (also `M`, `efConstruction`, `efRuntime`) | `CREATE VECTOR INDEX activity_embedding IF NOT EXISTS FOR (n:Activity) ON n.embedding OPTIONS {indexConfig: {`vector.dimensions`: 1024, `vector.similarity_function`: 'cosine'}}` |
| Write | `SET n.embedding = vecf32($vector)`; a plain list is **silently not indexed** | `CALL db.create.setNodeVectorProperty(n, 'embedding', $vector)` (or `SET` of a float list) |
| Query | `CALL db.idx.vector.queryNodes('Activity', 'embedding', $k, vecf32($q)) YIELD node, score` | `CALL db.index.vector.queryNodes('activity_embedding', $k, $q) YIELD node, score` |
| Score | a **distance**, lower is closer (cosine distance, 0 identical); the documentation is inconsistent on this, so test it | similarity in 0..1, higher is closer, `(1 + cos) / 2` for cosine, best first |
| Dimensions | 1 to 4096 | 1 to 4096 |
| Filters | not combined with the index: documentation says vector queries "don't combine well with property filters"; filter after the call | the index returns the k nearest first, then `WHERE` filters, so a filtered result can have fewer than k rows |
| Gotchas | no `IF NOT EXISTS`; the migration runner already ignores "already indexed" errors for `CREATE INDEX`, confirm the vector message matches | one vector index per label and property; not queryable while `POPULATING` (check `SHOW VECTOR INDEXES`); a query fails in a transaction that already wrote, so write after the last query; community edition support is not stated on the manual page, CI on `neo4j:5.26-community` will say |
| Brute force alternative | `vec.cosineDistance(n.embedding, vecf32($q))` over a filtered set | `vector.similarity.cosine(n.embedding, $q)` over a filtered set |

How it fits the repo, without writing it:

- **Schema files**: one `CREATE VECTOR INDEX` line in each of `db/schema/falkordb.cypher` and
  `db/schema/neo4j.cypher`, with the dimension from the model decision (1024). The dialect directories under
  `apps/api/src/repositories/cypher/` get a `search-nearest.cypher` each, returning `node` and a score that
  the adapter converts to cosine similarity (`1 - score` for FalkorDB, `2 * score - 1` for Neo4j) so the
  hybrid ranking in TypeScript is dialect-free.
- **Loading**: the load job reads `embeddings.parquet` next to the bundle, checks the manifest's model,
  dimensions and checksum against the bundle's place ids, and sets `Activity.embedding` in the same
  idempotent `MERGE`. It must **refuse a model or dimension change without a new index** (drop and rebuild).
- **Filters**: ask for `k × 5` nearest, then filter by city, distance, category and opening day in the API
  and rerank. With a few thousand places per query set and filters that usually keep a city, this is enough.
- **Exact fallback**: 8,000 vectors of 1,024 float32 are 33 MB. Brute-force cosine over them in the API
  (or in Cypher over a pre-filtered city) is exact, needs no index in either dialect and filters
  trivially. It is the reference the approximate index is checked against (`eval-search` does the same
  in Python), and a reasonable first version if either dialect's index misbehaves.
- **Memory**: 1,024 floats a node add about 33 MB (plus the index graph) to the 1 GB FalkorDB VM; E5-small
  at 384 dimensions would be 12 MB. Set the property on the Activity node only; make sure no repository
  `RETURN n` returns it (it would be 4 KB per activity on every list call). Existing list queries should
  be checked for `RETURN a` or `properties(a)`.

## What remains for the app half

1. Run the two vector-index statements and queries in the integration harness on both databases; settle the
   FalkorDB score semantics and the Neo4j community-edition question.
2. Cloudflare account, token, and `parity_check.py` (or build the tiny service, option B).
3. `GET /trips/:id/search` (hybrid ranking, filters), the `semantic_search` assistant tool, the web search
   box, the long-tail Parquet index and its memory spike.
4. A `trippr-data embed` run on the laptop against the real bundle, uploaded with the bundle, and the
   load job step that reads it.
5. The enrich stage's `summary` flows into the embed text automatically (`FIELD_COLUMNS` already looks for a
   `summary` column), but bump `TEXT_VERSION` if the template changes, and re-run `eval-search`.
6. Optionally measure option D with the owner's approval (under 5 cents).
