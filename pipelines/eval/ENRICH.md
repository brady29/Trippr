# Enrichment eval set

`enrich_places.jsonl`: 162 places, one JSON object per line, hand-labelled for the `eval-enrich` command.

| Key | Meaning |
|---|---|
| `id`, `name`, `local`, `en` | The place id, its primary name and its local-script and English names |
| `cat`, `city`, `country` | A taxonomy category, a Trippr city code and the ISO country |
| `desc` | One short factual note written for this eval (the only prose the model sees). Missing on purpose for a few places, to test "no description" |
| `tags` | Reference tags: one to four taxonomy categories, most specific first |
| `dur` | Typical first-visit time in minutes |
| `best` | `morning`, `afternoon`, `evening`, `night` or `any` |
| `indoor` | `true`, `false`, or `null` when mixed |

Coverage: Japan 33, China 25, South Korea 15, Vietnam 13, Taiwan 12, Thailand 12, Indonesia 8, Malaysia 7,
Singapore 7, Hong Kong 6, Cambodia 6, Macau 4, Laos 4, Philippines 3, Nepal 3, Mongolia 2, Sri Lanka 2.
Names are in Han/kana, Hangul, Thai, Khmer, Lao, Devanagari, Sinhala, Cyrillic and Latin (with Vietnamese
diacritics). Chains and plain restaurants are included beside landmarks.

The labels are one person's judgement of a typical first visit, so treat small differences as noise: duration
is scored within ±30 minutes for that reason. The notes in `desc` were written for this file from general
knowledge; they are not copied from Wikipedia, Wikivoyage or any other source, which keeps the file free of
share-alike text. When labels are fixed or places added, keep ids unique and tags inside
`config/taxonomy.csv` (a test checks both).

The spec asks for about 200 labelled places; this is the first 162. Treat the F1 it reports as an early
signal, and extend the set (especially descriptions as real as Wikivoyage's, once PR 2 and 3 land) before
trusting small differences between two models.
