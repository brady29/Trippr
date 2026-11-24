import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BUNDLE_FILES, activityPageQuery, bundleEnrichmentSchema, bundleManifestSchema, bundlePlaceSchema, bundleSourceInfoSchema } from "../src";

/** The bundle the pipeline's golden test writes (pipelines/tests/test_bundle.py): the Python and TypeScript sides must agree on it. */
const BUNDLE = resolve(import.meta.dirname, "../../../pipelines/tests/fixtures/expected/bundle/2026-11-18");
const read = (name: string) => readFileSync(resolve(BUNDLE, name));

describe("the seed bundle contract", () => {
  const manifest = bundleManifestSchema.parse(JSON.parse(read("manifest.json").toString("utf8")));
  const places = gunzipSync(read("places.jsonl.gz"))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => bundlePlaceSchema.parse(JSON.parse(line)));
  const sources = (JSON.parse(read("sources.json").toString("utf8")) as unknown[]).map((s) => bundleSourceInfoSchema.parse(s));

  it("parses the manifest, the places and the sources the pipeline wrote", () => {
    expect(manifest.checks.passed).toBe(true);
    expect(places.length).toBe(manifest.counts.places);
    expect(sources.map((s) => s.id)).toEqual(expect.arrayContaining(["foursquare", "overture"]));
  });

  it("keeps provenance on every place", () => {
    for (const p of places) {
      expect(p.sources.length).toBeGreaterThan(0);
      expect(p.sources.every((s) => s.licence && s.source_id)).toBe(true);
    }
    expect(manifest.counts.with_licence).toBe(places.length);
  });

  it("agrees with the manifest's counts", () => {
    const byCity: Record<string, number> = {};
    for (const p of places) byCity[p.city_code] = (byCity[p.city_code] ?? 0) + 1;
    expect(byCity).toEqual(manifest.counts.by_city);
    expect(new Set(places.map((p) => p.id)).size).toBe(places.length);
  });

  it("rejects places that break the contract", () => {
    const good = places[0]!;
    expect(bundlePlaceSchema.safeParse({ ...good, sources: [] }).success).toBe(false);
    expect(bundlePlaceSchema.safeParse({ ...good, tag: "shopping" }).success).toBe(false);
    expect(bundlePlaceSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
    expect(bundlePlaceSchema.safeParse({ ...good, id: "act-1" }).success).toBe(false);
    expect(bundlePlaceSchema.safeParse({ ...good, lat: 200 }).success).toBe(false);
  });

  it("refuses a manifest of another format", () => {
    expect(bundleManifestSchema.safeParse({ ...manifest, format: 2 }).success).toBe(false);
  });
});

describe("the enrichment part of the bundle", () => {
  const manifest = bundleManifestSchema.parse(JSON.parse(read("manifest.json").toString("utf8")));
  const places = gunzipSync(read("places.jsonl.gz")).toString("utf8").split("\n").filter(Boolean).map((l) => bundlePlaceSchema.parse(JSON.parse(l)));
  const items = gunzipSync(read(BUNDLE_FILES.enrichment))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => bundleEnrichmentSchema.parse(JSON.parse(line)));

  it("parses what the pipeline wrote and agrees with the manifest", () => {
    expect(items.length).toBeGreaterThan(0);
    expect(manifest.enrichment).toMatchObject({ places: items.length, with_summary: items.filter((i) => i.summary).length });
    expect(manifest.files.map((f) => f.name)).toContain(BUNDLE_FILES.enrichment);
    const ids = new Set(places.map((p) => p.id));
    expect(items.every((i) => ids.has(i.id))).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it("marks every summary as written by AI", () => {
    for (const i of items.filter((x) => x.summary)) {
      expect(i.ai).toBe(true);
      expect(i.provenance.summary_ai).toBe(true);
      expect(i.ai_label).toMatch(/^Summary written by AI/);
    }
  });

  it("rejects values outside the model's vocabulary and unknown fields", () => {
    const good = items[0]!;
    expect(bundleEnrichmentSchema.safeParse({ ...good, best_time: "dawn" }).success).toBe(false);
    expect(bundleEnrichmentSchema.safeParse({ ...good, price_level: "$$$$" }).success).toBe(false);
    expect(bundleEnrichmentSchema.safeParse({ ...good, duration_min: 2 }).success).toBe(false);
    expect(bundleEnrichmentSchema.safeParse({ ...good, summary: "x".repeat(141) }).success).toBe(false);
    expect(bundleEnrichmentSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
  });

  it("still accepts a manifest from a bundle with no enrichment", () => {
    const { enrichment: _drop, ...older } = manifest;
    expect(bundleManifestSchema.safeParse(older).success).toBe(true);
    expect(bundleManifestSchema.safeParse({ ...older, enrichment: null }).success).toBe(true);
  });
});

describe("activityPageQuery", () => {
  it("defaults to the first page of 50", () => {
    expect(activityPageQuery.parse({})).toMatchObject({ scope: "all", offset: 0, limit: 50, sort: "relevance", fixedDates: false });
  });

  it("reads filters from a query string and ignores blanks", () => {
    const q = activityPageQuery.parse({ city: "tyo", tag: "Food", q: "  ramen ", source: "", minScore: "2.5", maxRank: "25", limit: "20", fixedDates: "true" });
    expect(q).toMatchObject({ city: "TYO", tag: "food", q: "ramen", minScore: 2.5, maxRank: 25, limit: 20, fixedDates: true });
    expect(q.source).toBeUndefined();
  });

  it("reads the enrichment filters", () => {
    const q = activityPageQuery.parse({ bestTime: "evening", indoor: "false", durationMax: "90", priceLevel: "$$" });
    expect(q).toMatchObject({ bestTime: "evening", indoor: false, durationMax: 90, priceLevel: "$$" });
    expect(activityPageQuery.parse({ indoor: "true" }).indoor).toBe(true);
    const blank = activityPageQuery.parse({ bestTime: "", indoor: "", durationMax: "", priceLevel: "" });
    expect(blank.bestTime).toBeUndefined();
    expect(blank.indoor).toBeUndefined();
    expect(blank.durationMax).toBeUndefined();
    expect(blank.priceLevel).toBeUndefined();
    expect(activityPageQuery.safeParse({ bestTime: "dusk" }).success).toBe(false);
    expect(activityPageQuery.safeParse({ priceLevel: "$$$$" }).success).toBe(false);
    expect(activityPageQuery.safeParse({ durationMax: "1" }).success).toBe(false);
  });

  it("caps the page size", () => {
    expect(activityPageQuery.safeParse({ limit: "500" }).success).toBe(false);
    expect(activityPageQuery.safeParse({ offset: "-1" }).success).toBe(false);
    expect(activityPageQuery.safeParse({ scope: "everything" }).success).toBe(false);
  });
});
