import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { bundleHotelSchema, bundleManifestSchema, bundleStayUnitSchema, coverageNote, createAreaBody, STAY_CELLS_DEFAULT, STAY_PART_KEYS, stayCellsQuery } from "../src";

/** The golden bundle the pipeline's tests write: the Python (pydantic) and TypeScript (zod) sides must agree on its stay tables. */
const BUNDLE = resolve(import.meta.dirname, "../../../pipelines/tests/fixtures/expected/bundle/2026-11-18");
const lines = (name: string) =>
  gunzipSync(readFileSync(resolve(BUNDLE, name)))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);

describe("the bundle's stay tables", () => {
  const manifest = bundleManifestSchema.parse(JSON.parse(readFileSync(resolve(BUNDLE, "manifest.json"), "utf8")));
  const units = lines("stay_unit.jsonl.gz").map((l) => bundleStayUnitSchema.parse(l));
  const hotels = lines("hotels.jsonl.gz").map((l) => bundleHotelSchema.parse(l));

  it("parses what the pipeline wrote and agrees with the manifest", () => {
    const stay = manifest.stay!;
    expect(stay).toBeDefined();
    expect(hotels).toHaveLength(stay.hotels);
    for (const [kind, n] of Object.entries(stay.units)) expect(units.filter((u) => u.unit_kind === kind)).toHaveLength(n);
    expect(stay.coverage.inside_airbnb_cities).toBe(stay.cities.length);
    expect(Object.keys(stay.weights).sort()).toEqual([...STAY_PART_KEYS].sort());
    expect(manifest.files.map((f) => f.name)).toEqual(expect.arrayContaining(["stay_unit.jsonl.gz", "hotels.jsonl.gz"]));
  });

  it("lists every score part and an explanation for scored units", () => {
    const scored = units.filter((u) => u.stay_score !== null);
    expect(scored.length).toBeGreaterThan(0);
    for (const u of scored) {
      expect(u.score_parts.length).toBeGreaterThan(0);
      expect(u.explanation).toBeTruthy();
      expect(u.weight_coverage).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("keeps hotel provenance and publishes aggregates only", () => {
    for (const h of hotels) expect(h.sources.every((s) => s.licence && s.fetched_at.endsWith("Z"))).toBe(true);
    const fields = Object.keys(bundleStayUnitSchema.shape);
    expect(fields.filter((f) => /listing_id|host_id|host_name|url|picture|link/.test(f))).toEqual([]);
    // Units under the privacy minimum carry no statistics.
    for (const u of units.filter((u) => u.n_listings < 3)) expect(u.median_price_cad).toBeNull();
  });

  it("rejects rows that break the contract", () => {
    expect(bundleStayUnitSchema.safeParse({ ...units[0], listing_id: 123 }).success).toBe(false);
    expect(bundleStayUnitSchema.safeParse({ ...units[0], unit_kind: "listing" }).success).toBe(false);
    expect(bundleHotelSchema.safeParse({ ...hotels[0], sources: [] }).success).toBe(false);
  });

  it("is optional: a manifest without a stay section still parses", () => {
    const { stay: _stay, ...rest } = manifest;
    expect(bundleManifestSchema.safeParse(rest).success).toBe(true);
  });
});

describe("stayCellsQuery", () => {
  it("needs a city or a viewport", () => {
    expect(stayCellsQuery.safeParse({}).success).toBe(false);
    expect(stayCellsQuery.safeParse({ city: "" }).success).toBe(false);
  });

  it("reads a city, a bbox and a limit", () => {
    expect(stayCellsQuery.parse({ city: "tyo" })).toEqual({ layer: "h3", city: "TYO", limit: STAY_CELLS_DEFAULT });
    const q = stayCellsQuery.parse({ bbox: "139.5,35.5,140,35.9", limit: "200" });
    expect(q.bbox).toEqual({ minLon: 139.5, minLat: 35.5, maxLon: 140, maxLat: 35.9 });
    expect(q.limit).toBe(200);
    expect(stayCellsQuery.parse({ city: "TYO", layer: "neighbourhood" }).layer).toBe("neighbourhood");
    expect(stayCellsQuery.safeParse({ city: "TYO", layer: "listing" }).success).toBe(false);
  });

  it("refuses bad viewports and over-large pages", () => {
    expect(stayCellsQuery.safeParse({ bbox: "1,2,3" }).success).toBe(false);
    expect(stayCellsQuery.safeParse({ bbox: "140,35,139,36" }).success).toBe(false);
    expect(stayCellsQuery.safeParse({ bbox: "-200,0,10,10" }).success).toBe(false);
    expect(stayCellsQuery.safeParse({ city: "TYO", limit: "5000" }).success).toBe(false);
  });
});

describe("the Area radius", () => {
  const base = { tripId: "asia-2027", cityCode: "TYO", name: "Ueno" };
  it("is optional and bounded", () => {
    expect(createAreaBody.parse(base).radiusKm).toBeUndefined();
    expect(createAreaBody.parse({ ...base, radiusKm: 2 }).radiusKm).toBe(2);
    expect(createAreaBody.safeParse({ ...base, radiusKm: 50 }).success).toBe(false);
    expect(createAreaBody.safeParse({ ...base, radiusKm: 0 }).success).toBe(false);
  });
});

describe("coverageNote", () => {
  it("says how many cities have Inside Airbnb data", () => {
    expect(coverageNote(5, 108)).toBe("Inside Airbnb covers 5 of 108 cities");
  });
});
