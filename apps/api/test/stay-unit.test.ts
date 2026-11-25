import { describe, expect, it } from "vitest";
import { coverageNote } from "@trippr/contracts";
import { localStore, readBundle } from "../src/services/catalogue/bundle";
import { dataStayView, hotelRow, marketRow, storedAreaStay } from "../src/services/catalogue/stay";
import { buildAreaStay, cellsResponse, coverageOf, quantile, rankHotels, stayNote, toSuggestion } from "../src/services/stay";
import type { GraphClient } from "../src/db/graph";
import { cypher } from "../src/repositories/queries";
import { stayRepository, type StoredHotel, type StoredMarket } from "../src/repositories/stay";
import { GOLDEN_BUNDLE_DIR, tempBundleRoot } from "./bundle-kit";
import { cell, cityUnit, hotel, marketArea, STAY_SOURCES, unit, writeStayBundle } from "./stay-kit";

// No database needed: the stay formulas, the stored card, the cell trimming and the bundle reader.

const WEIGHTS = { value: 0.25, centrality: 0.3, walkability: 0.2, quiet: 0.15, reviews: 0.1 };
const LOAD = { bundleDate: "2026-11-18", loadedAt: "2026-11-24T00:00:00Z", runDate: "2026-11-18", coverageCities: 5, trippCities: 108, stay: { attribution: "Data from Inside Airbnb (insideairbnb.com), CC BY 4.0" } };

describe("the stored Area card", () => {
  const tokyo = cityUnit("TYO", "Tokyo");

  it("keeps the parts with their weights and the explanation", () => {
    const card = storedAreaStay(marketArea("area-tyo-shibuya", "TYO", "Shibuya"), { city: tokyo, weights: WEIGHTS, hotelSuggestions: 3 });
    expect(card).toMatchObject({ availability: "market", cityCovered: true, score: 59.9, weightCoverage: 1, hotelSuggestions: 3, snapshotDate: "2026-09-25" });
    expect(card.parts.map((p) => [p.key, p.score, p.weight])).toEqual([
      ["value", 30.5, 0.25],
      ["centrality", 70, 0.3],
      ["walkability", 90, 0.2],
      ["quiet", 40, 0.15],
      ["reviews", 82, 0.1],
    ]);
    expect(card.price).toMatchObject({ medianCad: 197.32, p25Cad: 144.16, p75Cad: 245.53, perPersonCad: 80.5, cityMedianCad: 137.41 });
    expect(card.market).toMatchObject({ listings: 40, priced: 38, medianRating: 4.82, lowSample: false });
    expect(card.location).toEqual({ centreKm: 3.2, stationKm: 3.2, radiusKm: 1.5 });
    expect(card.explanation).toContain("Cheaper than 30%");
  });

  it("is places-only without prices but with a score, and none without either", () => {
    const placesOnly = unit({ unit_kind: "area", unit_id: "area-bjs-gulou", city_code: "BJS", radius_km: 1.5, stay_score: 55, score_centrality: 80, score_walkability: 60, score_parts: ["centrality", "walkability"], weight_coverage: 0.5 });
    const a = storedAreaStay(placesOnly, { city: null, weights: WEIGHTS, hotelSuggestions: 0 });
    expect(a).toMatchObject({ availability: "places", cityCovered: false, score: 55, price: null, market: null });
    const nothing = storedAreaStay(unit({ unit_kind: "area", unit_id: "area-x", city_code: "BJS" }), { city: null, weights: WEIGHTS, hotelSuggestions: 0 });
    expect(nothing).toMatchObject({ availability: "none", score: null });
    expect(nothing.parts.every((p) => p.score === null)).toBe(true);
  });
});

describe("the honest card", () => {
  const stored = (over = {}) => ({ id: "area-x", cityCode: "TYO", cityName: "Tokyo", radiusKm: 1.5, bundleDate: "2026-11-18", hotelSuggestions: 0, stay: null as Record<string, unknown> | null, ...over });

  it("says there is no stay data for a city Inside Airbnb does not cover, with the coverage note", () => {
    const card = buildAreaStay(stored({ cityCode: "BJS", cityName: "Beijing" }), { load: LOAD, cityCovered: false });
    expect(card).toMatchObject({ availability: "none", cityCovered: false, score: null, attribution: null });
    expect(card.note).toBe("No stay data for Beijing. Inside Airbnb covers 5 of 108 cities.");
    expect(card.coverage).toEqual({ coveredCities: 5, trippCities: 108, note: "Inside Airbnb covers 5 of 108 cities" });
  });

  it("explains an area that is not measured in a covered city", () => {
    const card = buildAreaStay(stored(), { load: LOAD, cityCovered: true });
    expect(card.availability).toBe("none");
    expect(card.note).toContain("not one of the areas the data run measures");
  });

  it("gives market cards the attribution and a sentence about their listings and snapshot", () => {
    const area = storedAreaStay(marketArea("area-tyo-shibuya", "TYO", "Shibuya"), { city: cityUnit("TYO", "Tokyo"), weights: WEIGHTS, hotelSuggestions: 2 });
    const card = buildAreaStay(stored({ stay: area as unknown as Record<string, unknown>, hotelSuggestions: 2 }), { load: LOAD, cityCovered: true, attribution: "Data from Inside Airbnb (insideairbnb.com), CC BY 4.0" });
    expect(card.availability).toBe("market");
    expect(card.attribution).toBe("Data from Inside Airbnb (insideairbnb.com), CC BY 4.0");
    expect(card.note).toBe("From 40 Inside Airbnb listings in the 2026-09-25 snapshot. Asking prices in CAD, not quotes.");
    expect(card.bundleDate).toBe("2026-11-18");
  });

  it("scores from places only for a city with no market data", () => {
    const card = { availability: "places" as const, cityCovered: false, cityName: "Hanoi", snapshotDate: null, market: null, coverage: coverageOf(LOAD) };
    expect(stayNote(card)).toBe("No stay data for Hanoi: there is no price data, so the score comes from location and nearby places only. Inside Airbnb covers 5 of 108 cities.");
    expect(stayNote({ ...card, cityCovered: true })).toContain("Too few Inside Airbnb listings");
  });

  it("works before any stay load", () => {
    const card = buildAreaStay(stored(), { load: null, cityCovered: false });
    expect(card.coverage).toBeNull();
    expect(card.note).toBe("No stay data for Tokyo.");
  });

  it("formats the coverage note", () => {
    expect(coverageNote(5, 108)).toBe("Inside Airbnb covers 5 of 108 cities");
  });
});

describe("the map layer's rows", () => {
  const units = [
    cityUnit("TYO", "Tokyo"),
    cell("8864a41611fffff", "TYO", 35.66, 139.7, { median_price_cad: 100, n_listings: 12 }),
    cell("8864a41613fffff", "TYO", 35.7, 139.8, { median_price_cad: 200, n_listings: 4 }),
    cell("8864a41615fffff", "TYO", 35.5, 139.5, { median_price_cad: 300, n_listings: 9, stay_score: null }),
    unit({ unit_kind: "neighbourhood", unit_id: "TYO/Shibuya Ku", city_code: "TYO", name: "Shibuya Ku", lat: 35.66, lon: 139.7, n_listings: 40, median_price_cad: 150, stay_score: 60 }),
  ];

  it("puts a city's cells and neighbourhoods in one compact row each, with a box around them", () => {
    const m = marketRow("TYO", units, "2026-11-18")!;
    expect(JSON.parse(m.cells)).toEqual([
      ["8864a41611fffff", 35.66, 139.7, 100, 50, 12, 55],
      ["8864a41613fffff", 35.7, 139.8, 200, 50, 4, 55],
      ["8864a41615fffff", 35.5, 139.5, 300, 50, 9, null],
    ]);
    expect(JSON.parse(m.neighbourhoods)).toEqual([["TYO/Shibuya Ku", 35.66, 139.7, 150, null, 40, 60, "Shibuya Ku"]]);
    expect(m).toMatchObject({ cityCode: "TYO", name: "Tokyo", cellCount: 3, snapshotDate: "2026-09-25" });
    expect(m.minLat).toBeLessThan(35.5);
    expect(m.maxLon).toBeGreaterThan(139.8);
    expect(marketRow("OSA", units, "2026-11-18")).toBeNull();
    expect(marketRow("TYO", units, "2026-11-18")!.hash).toBe(m.hash);
  });

  const market = (cells: unknown[][]): StoredMarket => ({ cityCode: "TYO", name: "Tokyo", snapshotDate: "2026-09-25", bundleDate: "2026-11-18", city: { medianPriceCad: 137 }, rows: cells });
  const rows = JSON.parse(marketRow("TYO", units, "2026-11-18")!.cells) as unknown[][];

  it("trims to the viewport but takes the colour scale from the whole city", () => {
    const all = cellsResponse([market(rows)], { limit: 100, layer: "h3" });
    expect(all.cells).toHaveLength(3);
    expect(all.cities[0]).toMatchObject({ cityCode: "TYO", cityMedianCad: 137, scale: { low: 120, high: 280 } });
    const view = cellsResponse([market(rows)], { bbox: { minLon: 139.6, minLat: 35.6, maxLon: 139.9, maxLat: 35.8 }, limit: 100, layer: "h3" });
    expect(view.cells.map((c) => c.id)).toEqual(["8864a41611fffff", "8864a41613fffff"]);
    expect(view.cities[0]!.scale).toEqual(all.cities[0]!.scale);
    expect(view.attribution).toContain("Inside Airbnb");
    expect(cellsResponse([market(rows)], { bbox: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }, limit: 100, layer: "h3" })).toMatchObject({ cells: [], total: 0, truncated: false, attribution: null });
  });

  it("caps the page, keeping the cells with the most listings", () => {
    const page = cellsResponse([market(rows)], { limit: 2, layer: "h3" });
    expect(page).toMatchObject({ total: 3, truncated: true });
    expect(page.cells.map((c) => c.listings)).toEqual([12, 9]);
  });

  it("names neighbourhoods and carries no listing-level field", () => {
    const hood = cellsResponse([market(JSON.parse(marketRow("TYO", units, "x")!.neighbourhoods) as unknown[][])], { limit: 10, layer: "neighbourhood" });
    expect(hood.cells[0]).toMatchObject({ id: "TYO/Shibuya Ku", name: "Shibuya Ku", price: 150, listings: 40 });
    for (const c of all(hood.cells)) expect(Object.keys(c).every((k) => ["id", "name", "city", "lat", "lon", "price", "pp", "listings", "score"].includes(k))).toBe(true);
  });

  it("computes quantiles by interpolation", () => {
    expect(quantile([10], 0.9)).toBe(10);
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5], 0.1)).toBeCloseTo(1.4);
  });
});
const all = <T>(x: T[]) => x;

describe("hotels", () => {
  const stored = (over: Partial<StoredHotel>): StoredHotel => ({
    id: "h_1", name: "Hotel", nameLocal: null, kind: "hotel", lat: 0, lon: 0, address: null, website: null, stars: null, nSources: 1, areaDistKm: 0.5, sources: [{ source: "overture", sourceId: "o", licence: "CDLA-Permissive-2.0" }], ...over,
  });

  it("ranks hotels listed by more sources, with stars and a website, then the closer one", () => {
    const ranked = rankHotels([
      stored({ id: "a", name: "Plain", nSources: 1 }),
      stored({ id: "b", name: "Starry", nSources: 1, stars: 4, website: "https://x.example" }),
      stored({ id: "c", name: "Three sources", nSources: 3 }),
      stored({ id: "d", name: "Plain but close", nSources: 1, areaDistKm: 0.1 }),
    ]);
    expect(ranked.map((h) => h.id)).toEqual(["c", "b", "d", "a"]);
  });

  it("shows each distinct source and licence once", () => {
    const s = toSuggestion(stored({ sources: [{ source: "osm_lodging", sourceId: "n/1", licence: "ODbL-1.0" }, { source: "osm_lodging", sourceId: "n/2", licence: "ODbL-1.0" }, { source: "overture", sourceId: "o", licence: "CDLA-Permissive-2.0" }] }));
    expect(s.sources).toEqual([{ source: "osm_lodging", licence: "ODbL-1.0" }, { source: "overture", licence: "CDLA-Permissive-2.0" }]);
  });

  it("rows are stable, English-first, and change when the hotel does", () => {
    const h = hotel("area-tyo-shibuya", "TYO", { name: "渋谷ホテル", name_en: "Shibuya Hotel", name_local: "渋谷ホテル" });
    const row = hotelRow(h, "2026-11-18", "2026-11-24T00:00:00Z");
    expect(row).toMatchObject({ name: "Shibuya Hotel", nameLocal: "渋谷ホテル", areaId: "area-tyo-shibuya", sourceIds: ["overture"] });
    expect(hotelRow(h, "2026-12-01", "2026-12-02T00:00:00Z").contentHash).toBe(row.contentHash);
    expect(hotelRow({ ...h, stars: 4 }, "2026-11-18", "x").contentHash).not.toBe(row.contentHash);
    expect(JSON.parse(row.sources)).toEqual([{ source: "overture", sourceId: h.sources[0]!.source_id, licence: "CDLA-Permissive-2.0" }]);
  });
});

describe("reading a bundle's stay tables", () => {
  it("reads the golden bundle the pipeline writes, stay tables included", async () => {
    const b = await readBundle(localStore(GOLDEN_BUNDLE_DIR), "2026-11-18");
    expect(b.stay).not.toBeNull();
    expect(b.stay!.units.length).toBe(Object.values(b.stay!.section.units).reduce((a, n) => a + n, 0));
    expect(b.stay!.hotels.length).toBe(b.stay!.section.hotels);
    expect(b.stay!.units.some((u) => u.unit_id === "area-tyo-shibuya" && u.score_centrality !== null)).toBe(true);
  });

  it("builds the Data page's stay section from it", async () => {
    const b = await readBundle(localStore(GOLDEN_BUNDLE_DIR), "2026-11-18");
    const view = dataStayView(b, 7, "2026-11-24T00:00:00Z");
    expect(view.coverage).toEqual({ coveredCities: 2, trippCities: 108, note: "Inside Airbnb covers 2 of 108 cities" });
    expect(view.cities.map((c) => c.cityCode)).toEqual(["SIN", "TYO"]);
    expect(view.cities.every((c) => c.snapshotDate)).toBe(true);
    expect(view.checks?.passed).toBe(true);
    expect(view.attribution).toContain("Inside Airbnb");
    expect(view.licence).toBe("CC-BY-4.0");
    expect(view.hotels).toMatchObject({ inGraph: 7, perAreaCap: 150 });
  });

  it("reads a bundle without stay tables as before", async () => {
    const root = tempBundleRoot();
    const { writeBundle, place } = await import("./bundle-kit");
    writeBundle(root, { date: "2026-12-01", places: [place({ name: "Only a place" })] });
    const b = await readBundle(localStore(root), "2026-12-01");
    expect(b.stay).toBeNull();
  });

  it("refuses a stay file that does not match its checksum, a count that does not match, and files without a section", async () => {
    const root = tempBundleRoot();
    const area = marketArea("area-tyo-shibuya", "TYO", "Shibuya");
    const good = { units: [cityUnit("TYO", "Tokyo"), area], hotels: [hotel("area-tyo-shibuya", "TYO")] };
    writeStayBundle(root, { date: "2026-12-02", ...good, corrupt: "units" });
    await expect(readBundle(localStore(root), "2026-12-02")).rejects.toThrow(/stay_unit\.jsonl\.gz does not match its checksum/);
    writeStayBundle(root, { date: "2026-12-03", ...good, noSection: true });
    await expect(readBundle(localStore(root), "2026-12-03")).rejects.toThrow(/no stay section/);
    writeStayBundle(root, { date: "2026-12-04", ...good });
    expect((await readBundle(localStore(root), "2026-12-04")).stay!.units).toHaveLength(2);
    // A hotel from a source the bundle does not list.
    const stray = hotel("area-tyo-shibuya", "TYO", { sources: [{ source: "mystery", source_id: "m1", licence: "MIT", fetched_at: "2026-11-18T00:00:00Z" }] });
    writeStayBundle(root, { date: "2026-12-05", units: good.units, hotels: [stray] });
    await expect(readBundle(localStore(root), "2026-12-05")).rejects.toThrow(/missing from sources\.json: mystery/);
    expect(STAY_SOURCES.map((s) => s.id)).toEqual(expect.arrayContaining(["insideairbnb", "osm_lodging"]));
  });
});

describe("reading the map layer back from the graph", () => {
  const units = [
    cityUnit("TYO", "Tokyo"),
    cell("8864a41611fffff", "TYO", 35.66, 139.7, { median_price_cad: 100, n_listings: 12 }),
    unit({ unit_kind: "neighbourhood", unit_id: "TYO/Shibuya Ku", city_code: "TYO", name: "Shibuya Ku", lat: 35.66, lon: 139.7, n_listings: 40, median_price_cad: 150, stay_score: 60 }),
  ];
  const stored = marketRow("TYO", units, "2026-11-18")!;

  /** A graph that answers the way the database does: the query's CASE picks the JSON for the layer asked for. */
  const fakeDb = (seen: { params?: Record<string, unknown> }): GraphClient =>
    ({
      dialect: "falkordb",
      async query(_text: string, params: Record<string, unknown> = {}) {
        seen.params = params;
        const rows = params.layer === "h3" ? stored.cells : stored.neighbourhoods;
        return [{ market: { cityCode: "TYO", name: "Tokyo", snapshotDate: stored.snapshotDate, bundleDate: "2026-11-18", city: stored.city }, rows }];
      },
    }) as unknown as GraphClient;

  it("the query reads both JSON properties and picks one by $layer (it once returned only the cells)", () => {
    const text = cypher("stay-data/markets-cells", "falkordb");
    expect(text).toContain("m.cells");
    expect(text).toContain("m.neighbourhoods");
    expect(text).toContain("$layer");
  });

  it("returns the neighbourhoods for layer=neighbourhood and the cells for layer=h3", async () => {
    const seen: { params?: Record<string, unknown> } = {};
    const repo = stayRepository(fakeDb(seen));
    const hoods = await repo.markets({ city: "TYO", layer: "neighbourhood" });
    expect(seen.params).toMatchObject({ city: "TYO", layer: "neighbourhood", minLat: null });
    expect(hoods[0]!.rows).toEqual([["TYO/Shibuya Ku", 35.66, 139.7, 150, null, 40, 60, "Shibuya Ku"]]);
    const res = cellsResponse(hoods, { limit: 10, layer: "neighbourhood" });
    expect(res.cells).toEqual([{ id: "TYO/Shibuya Ku", name: "Shibuya Ku", city: "TYO", lat: 35.66, lon: 139.7, price: 150, pp: null, listings: 40, score: 60 }]);
    const cells = await repo.markets({ city: "TYO", layer: "h3" });
    expect(cells[0]!.rows.map((r) => r[0])).toEqual(["8864a41611fffff"]);
  });

  it("a viewport that contains the neighbourhood keeps it", async () => {
    const bbox = { minLon: 139.6, minLat: 35.6, maxLon: 139.9, maxLat: 35.8 };
    const markets = await stayRepository(fakeDb({})).markets({ layer: "neighbourhood", bbox });
    expect(cellsResponse(markets, { bbox, limit: 10, layer: "neighbourhood" }).cells.map((c) => c.id)).toEqual(["TYO/Shibuya Ku"]);
  });
});
