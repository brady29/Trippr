# Entity-resolution evaluation pairs

`er_pairs.csv` holds 408 candidate pairs from the matcher's blocking step, 68 in each of six cities:

| City | Country | Script |
|---|---|---|
| UKY Kyoto | Japan | Japanese |
| SHA Shanghai | China | Chinese and English |
| PUS Busan | South Korea | Hangul |
| HAN Hanoi | Vietnam | Latin with diacritics |
| CNX Chiang Mai | Thailand | Thai |
| RMQ Taichung | Taiwan | Traditional Chinese |

**These labels were written by the pipeline's author (an AI assistant) by reading each pair's names,
categories, addresses, websites and distance. They have not been reviewed by a person and need human
review before the 95% / 85% targets are treated as measured.** Where the labeller could not decide, the
label is `?` and the pair is left out of the numbers (25 of 408).

## Columns

`pair_id`, `city_code`, `distance_m`, then the two records (`a_*`, `b_*`: record id as `source:source_id`,
name, English name, local name, category, address, website, Wikidata QID), then:

- `label`: `1` the two records are the same real-world place, `0` they are different places, `?` cannot tell.
- `note`: free text.

The matcher's scores are deliberately not in the file, so labelling is not anchored by them.

## How the pairs were chosen

`python -m trippr_data sample-er` takes the pairs the blocking step produces (different sources, same or
neighbouring geohash-7 cells, within 500 m, compatible category families) and samples them in strata of
the matcher's confidence (strong links, scores of 0.9 and above, 0.78 to 0.9, 0.6 to 0.78, 0.4 to 0.6,
and low scores with similar names), so both easy and borderline pairs are labelled. The sample is
deterministic (ordered by a hash of the two record ids).

**Limits of this set.**
- It was drawn from the Overture, Foursquare, Wikidata and Wikivoyage records. OpenStreetMap was not yet
  available for these cities when the pairs were sampled (only Tokyo and Guangzhou were), so pairs with an
  OpenStreetMap record are not in it. Re-run `sample-er` once OpenStreetMap is extracted for them, and keep
  the existing labels (the command copies labels for pairs that are still sampled).
- Most pairs are Foursquare against Overture, the two biggest sources; Overture already includes Foursquare
  data, so many true matches are the same Foursquare record seen twice.
- Recall is measured among pairs the blocking step generates. A true match more than about 150 to 300 m
  apart (outside the neighbouring cells) is never a candidate and is not counted.

## Labelling rules used

- Same name and place, or the same shop written in two scripts or with a branch suffix: `1`.
- Different shops in the same building or mall (same address, different names): `0`, even though they share
  an address. A place that changed names over time is also `0`.
- A sub-feature of a place against the whole place (a temple's west gate against the temple, a pastor's house
  against the church): `0`.
- A chain's different branches (same brand, different addresses): `0`; same brand and address: `1`.
- Anything where the evidence points both ways: `?`.

## Running

```sh
uv run python -m trippr_data eval-er          # precision and recall at the chosen threshold, plus a sweep
uv run python -m trippr_data eval-er --threshold 0.85
uv run python -m trippr_data sample-er        # rewrite the file with a fresh sample, keeping labels of pairs still in it
```

`eval-er` re-runs the matcher for the labelled cities and counts a pair as predicted-same when both
records end up in the same cluster (so the best-partner pruning and the spread guard are included).
Results are written to `matched/<date>/eval.json` and shown in the run report.
