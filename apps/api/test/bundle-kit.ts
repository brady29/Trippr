import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { BundleEnrichment, BundleManifest, BundlePlace, BundleSourceInfo } from "@trippr/contracts";

/** The bundles folder the pipeline golden test commits: real Overture and Foursquare fixture rows for Tokyo and Osaka. */
export const GOLDEN_BUNDLE_DIR = resolve(import.meta.dirname, "../../../pipelines/tests/fixtures/expected/bundle");

const FETCHED = "2026-11-18T00:00:00Z";

export const SOURCES: BundleSourceInfo[] = [
  {
    id: "overture",
    name: "Overture Maps Places",
    url: "https://docs.overturemaps.org/guides/places/",
    licence: "CDLA-Permissive-2.0 AND Apache-2.0 AND CC0-1.0",
    licence_detail: null,
    licence_urls: ["https://cdla.dev/permissive-2-0/"],
    attribution: "© Overture Maps Foundation, overturemaps.org",
    terms_checked_on: "2026-11-22",
    allowed_uses: ["Show places with attribution"],
    enabled: true,
    version: "2026-11-18.0",
    fetched_at: FETCHED,
    staged_rows: 1000,
    places: 0,
  },
  {
    id: "foursquare",
    name: "Foursquare Open Source Places",
    url: "https://docs.foursquare.com/data-products/docs/access-fsq-os-places",
    licence: "Apache-2.0",
    licence_detail: null,
    licence_urls: ["https://www.apache.org/licenses/LICENSE-2.0"],
    attribution: "Foursquare Open Source Places, Copyright 2024 Foursquare Labs, Inc.",
    terms_checked_on: "2026-11-22",
    allowed_uses: ["Show places with attribution"],
    enabled: true,
    version: "2026-11-17",
    fetched_at: FETCHED,
    staged_rows: 800,
    places: 0,
  },
];

let counter = 0;

/** A valid bundle place; override anything. */
export function place(over: Partial<BundlePlace> & { name: string }): BundlePlace {
  const n = ++counter;
  const id = over.id ?? `cat-${n.toString(16).padStart(16, "0")}`;
  return {
    id,
    golden_id: `g-${n}`,
    city_code: "TYO",
    name_local: null,
    name_en: null,
    category: "museum",
    tag: "culture",
    lat: 35.68 + n / 10_000,
    lon: 139.76,
    address: null,
    website: null,
    phone: null,
    opening_hours: null,
    wikidata_qid: null,
    description: null,
    score: 3,
    rank: n,
    n_sources: 1,
    confidence: 0.9,
    wikidata_sitelinks: null,
    wikivoyage_listed: null,
    sources: [{ source: "overture", source_id: `ov-${id}`, licence: "CDLA-Permissive-2.0", fetched_at: FETCHED, raw_ref: "raw/overture/TYO.parquet" }],
    ...over,
  };
}

/** A valid enrichment line for a place; override anything. The summary is AI-written unless the override says otherwise. */
export function enrichment(p: BundlePlace, over: Partial<Omit<BundleEnrichment, "provenance">> & { provenance?: Partial<BundleEnrichment["provenance"]> } = {}): BundleEnrichment {
  const { provenance, ...rest } = over;
  const summary = rest.summary ?? `${p.name} is worth a visit.`;
  return {
    id: p.id,
    tags: [p.category],
    summary,
    duration_min: 60,
    best_time: "morning",
    indoor: false,
    price_level: "$",
    good_for: ["views"],
    display_name: null,
    is_generic_name: false,
    ai: true,
    ai_label: summary ? "Summary written by AI from Overture Maps and Wikidata" : null,
    ...rest,
    provenance: { summary_ai: Boolean(summary), model: "claude-haiku-5-5", prompt_version: "enrich-v1", enriched_at: "2026-11-18T09:30:00Z", batch_id: "msgbatch_test", input_sources: ["overture", "wikidata"], ...provenance },
  };
}

export interface BundleOptions {
  date: string;
  places: BundlePlace[];
  passed?: boolean;
  sources?: BundleSourceInfo[];
  /** LLM enrichment for some of the places (written as enrichment.jsonl.gz, with the manifest's enrichment section). */
  enrichment?: BundleEnrichment[];
  /** Scores for the manifest's evals.enrich. */
  evals?: Record<string, unknown>;
  /** Corrupt a file after the manifest was written. */
  corrupt?: "places" | "sources" | "enrichment";
}

/** Write bundles/<date>/ the way the pipeline does (gzip JSON Lines, sources.json, manifest with checksums). */
export function writeBundle(root: string, options: BundleOptions): string {
  const dir = join(root, options.date);
  mkdirSync(dir, { recursive: true });
  const placesFile = gzipSync(Buffer.from(options.places.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8"));
  const bySource = new Map<string, number>();
  for (const p of options.places) for (const s of new Set(p.sources.map((s) => s.source))) bySource.set(s, (bySource.get(s) ?? 0) + 1);
  const sources = (options.sources ?? SOURCES).map((s) => ({ ...s, places: bySource.get(s.id) ?? 0 }));
  const sourcesFile = Buffer.from(JSON.stringify(sources, null, 2) + "\n", "utf8");
  const count = (key: (p: BundlePlace) => string) => {
    const out: Record<string, number> = {};
    for (const p of options.places) out[key(p)] = (out[key(p)] ?? 0) + 1;
    return out;
  };
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const enriched = options.enrichment;
  const enrichmentFile = enriched ? gzipSync(Buffer.from(enriched.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8")) : undefined;
  const manifest: BundleManifest = {
    format: 1,
    bundle_date: options.date,
    run_date: options.date,
    created_at: `${options.date}T12:00:00Z`,
    pipeline_version: "test",
    input: "golden",
    settings: { budget: { total: 8000, floor: 20, cap: 300 } },
    files: [
      { name: "places.jsonl.gz", sha256: sha(placesFile), bytes: placesFile.length, rows: options.places.length },
      { name: "sources.json", sha256: sha(sourcesFile), bytes: sourcesFile.length, rows: sources.length },
      ...(enrichmentFile && enriched ? [{ name: "enrichment.jsonl.gz", sha256: sha(enrichmentFile), bytes: enrichmentFile.length, rows: enriched.length }] : []),
    ],
    counts: {
      places: options.places.length,
      cities: new Set(options.places.map((p) => p.city_code)).size,
      by_city: count((p) => p.city_code),
      by_category: count((p) => p.category),
      by_tag: count((p) => p.tag),
      by_source: Object.fromEntries(bySource),
      with_licence: options.places.length,
      with_sources: options.places.length,
    },
    checks: {
      passed: options.passed ?? true,
      results: [
        { name: "provenance.licence", status: "pass", detail: "all places keep their source ids and a licence", data: {} },
        ...(options.passed === false ? [{ name: "duplicates.name_50m", status: "fail" as const, detail: "2 duplicate pairs", data: {} }] : []),
      ],
    },
    evals: options.evals ?? {},
    ...(enriched
      ? {
          enrichment: {
            places: enriched.length,
            with_summary: enriched.filter((e) => e.summary).length,
            models: [...new Set(enriched.map((e) => e.provenance.model))].sort(),
            prompt_versions: [...new Set(enriched.map((e) => e.provenance.prompt_version))].sort(),
            enriched_at: enriched.map((e) => e.provenance.enriched_at).sort().at(-1) ?? null,
            source_date: options.date,
          },
        }
      : {}),
  };
  if (enrichmentFile) writeFileSync(join(dir, "enrichment.jsonl.gz"), options.corrupt === "enrichment" ? Buffer.concat([enrichmentFile, Buffer.from("x")]) : enrichmentFile);
  writeFileSync(join(dir, "places.jsonl.gz"), options.corrupt === "places" ? Buffer.concat([placesFile, Buffer.from("x")]) : placesFile);
  writeFileSync(join(dir, "sources.json"), options.corrupt === "sources" ? Buffer.from("[]") : sourcesFile);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

export function tempBundleRoot(): string {
  return mkdtempSync(join(tmpdir(), "trippr-bundles-"));
}
