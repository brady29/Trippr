import type { Area, AreaStay, DataSourcesResponse, Hotel, HotelSuggestionsResponse, StayCellsResponse } from "@trippr/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localStore } from "../src/services/catalogue/bundle";
import { runLoadJob } from "../src/services/catalogue/job";
import { client, signIn, startHarness, type Harness } from "./harness";
import { GOLDEN_BUNDLE_DIR, place, tempBundleRoot, writeBundle } from "./bundle-kit";
import { cell, cityUnit, hotel, marketArea, unit, writeStayBundle } from "./stay-kit";

// Run on both databases in CI (DB_DIALECT=falkordb | neo4j). Docker was not available where this was written, so
// the Cypher these tests exercise has been checked by reading only until CI runs it.

const TRIP = "asia-2027";
const SHIBUYA = "area-tyo-shibuya";
const ASAKUSA = "area-tyo-asakusa";
const SHINJUKU = "area-tyo-shinjuku";
const BEIJING = "area-bjs-gulou";

let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;
let editor: Awaited<ReturnType<typeof signIn>>;
let viewer: Awaited<ReturnType<typeof signIn>>;
let stranger: Awaited<ReturnType<typeof signIn>>;

const root = tempBundleRoot();
const log: string[] = [];
const load = (options: { date?: string; dryRun?: boolean; store?: ReturnType<typeof localStore> } = {}) =>
  runLoadJob(
    { dryRun: options.dryRun ?? false, json: false, help: false, ...(options.date ? { date: options.date } : {}) },
    { db: h.db, store: options.store ?? localStore(root), log: (l) => log.push(l) },
  );
const count = async (cypher: string, params: Record<string, unknown> = {}) => Number(((await h.db.query<{ n: number }>(cypher, params))[0] ?? { n: 0 }).n);
const card = async (areaId: string, who = owner) => (await who.api.get<AreaStay>(`/areas/${areaId}/stay`)).body;
const suggestions = async (areaId: string, query = "") => (await owner.api.get<HotelSuggestionsResponse>(`/areas/${areaId}/hotel-suggestions${query}`)).body;
const cells = async (query: string, who = owner) => who.api.get<StayCellsResponse>(`/trips/${TRIP}/stay/cells?${query}`);

// Tokyo: three seeded Areas (Shibuya fully measured, Asakusa measured, Shinjuku with no unit at all), plus a Beijing area scored from places only.
const tokyo = cityUnit("TYO", "Tokyo");
const shibuya = marketArea(SHIBUYA, "TYO", "Shibuya");
const asakusa = marketArea(ASAKUSA, "TYO", "Asakusa", { stay_score: 66.5, median_price_cad: 112.63, p25_price_cad: 89.87, p75_price_cad: 136.28 });
const beijing = unit({
  unit_kind: "area",
  unit_id: BEIJING,
  city_code: "BJS",
  name: "Gulou",
  lat: 39.94,
  lon: 116.395,
  radius_km: 1.5,
  centre_km: 2.1,
  stay_score: 58,
  score_centrality: 85,
  score_walkability: 100,
  score_quiet: 0,
  score_parts: ["centrality", "walkability", "quiet"],
  weight_coverage: 0.65,
  explanation: "2.1 km from the city centre; 759 places within 600 m; 40 bars and nightlife venues within 300 m.",
});
const cellA = cell("8864a41611fffff", "TYO", 35.66, 139.7, { median_price_cad: 100, n_listings: 12 });
const cellB = cell("8864a41613fffff", "TYO", 35.7, 139.8, { median_price_cad: 200, n_listings: 4 });
const cellC = cell("8864a41615fffff", "TYO", 35.5, 139.5, { median_price_cad: 300, n_listings: 9 });
const hood = unit({ unit_kind: "neighbourhood", unit_id: "TYO/Shibuya Ku", city_code: "TYO", name: "Shibuya Ku", lat: 35.66, lon: 139.7, n_listings: 40, median_price_cad: 150, stay_score: 60 });

const hShibuya1 = hotel(SHIBUYA, "TYO", { name: "Shibuya Grand", stars: 4, website: "https://grand.example.com", n_sources: 3 });
const hShibuya2 = hotel(SHIBUYA, "TYO", {
  name: "Shibuya Guesthouse",
  kind: "guest_house",
  n_sources: 1,
  sources: [{ source: "osm_lodging", source_id: "node/1", licence: "ODbL-1.0", fetched_at: "2026-11-18T06:00:00Z" }],
});
const hAsakusa = hotel(ASAKUSA, "TYO", { name: "Asakusa Inn", kind: "inn" });
const hNowhere = hotel("area-does-not-exist", "TYO", { name: "Orphan Hotel" });

const FIRST = { date: "2026-11-20", units: [tokyo, shibuya, asakusa, beijing, cellA, cellB, cellC, hood], hotels: [hShibuya1, hShibuya2, hAsakusa, hNowhere] };

beforeAll(async () => {
  h = await startHarness();
  owner = await signIn(h.app, "Stay Owner");
  editor = await signIn(h.app, "Stay Editor");
  viewer = await signIn(h.app, "Stay Viewer");
  stranger = await signIn(h.app, "Stay Stranger");
  await owner.api.post(`/invites/${h.ownerInvite}/accept`);
  const e = await owner.api.post(`/trips/${TRIP}/invites`, { role: "editor" });
  await editor.api.post(`/invites/${e.body.token}/accept`);
  const v = await owner.api.post(`/trips/${TRIP}/invites`, { role: "viewer" });
  await viewer.api.post(`/invites/${v.body.token}/accept`);
});

afterAll(async () => {
  await h?.close();
});

describe("before any stay data", () => {
  it("says so, honestly, for every area", async () => {
    const c = await card(SHIBUYA);
    expect(c).toMatchObject({ areaId: SHIBUYA, cityCode: "TYO", cityName: "Tokyo", availability: "none", score: null, coverage: null, attribution: null, cityCovered: false });
    expect(c.note).toBe("No stay data for Tokyo.");
    expect((await suggestions(SHIBUYA)).hotels).toEqual([]);
    const layer = await cells("city=TYO");
    expect(layer.body).toMatchObject({ cells: [], cities: [], total: 0, truncated: false, attribution: null });
  });

  it("gives every Area a radius of 1.5 km, and lets an editor change it", async () => {
    const areas = (await viewer.api.get<Area[]>(`/cities/TYO/areas?tripId=${TRIP}`)).body;
    expect(areas.map((a) => a.radiusKm)).toEqual([1.5, 1.5, 1.5]);
    const created = await editor.api.post<Area>("/areas", { tripId: TRIP, cityCode: "TYO", name: "Ueno radius", radiusKm: 2.5 });
    expect(created.status).toBe(201);
    expect(created.body.radiusKm).toBe(2.5);
    expect((await editor.api.patch<Area>(`/areas/${created.body.id}`, { radiusKm: 0.8 })).body.radiusKm).toBe(0.8);
    expect((await editor.api.patch<Area>(`/areas/${created.body.id}`, { name: "Ueno radius 2" })).body.radiusKm).toBe(0.8);
    expect((await editor.api.patch(`/areas/${created.body.id}`, { radiusKm: 99 })).status).toBe(400);
    expect((await viewer.api.patch(`/areas/${created.body.id}`, { radiusKm: 1 })).status).toBe(403);
    expect((await editor.api.post<Area>("/areas", { tripId: TRIP, cityCode: "TYO", name: "Ueno default" })).body.radiusKm).toBe(1.5);
    expect((await editor.api.del(`/areas/${created.body.id}`)).status).toBe(204);
  });
});

describe("loading a bundle with stay tables", () => {
  it("a dry run says what would change and writes nothing", async () => {
    writeStayBundle(root, FIRST);
    const result = await load({ dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.summary!.stay).toMatchObject({ areas: 3, markets: 1, cells: 3, hotels: { created: 3, refreshed: 0, unchanged: 0, removed: 0, skippedNoArea: 1 } });
    expect(await count("MATCH (h:Hotel) WHERE h.catalogue = true RETURN count(h) AS n")).toBe(0);
    expect(await count("MATCH (m:StayMarket) RETURN count(m) AS n")).toBe(0);
    expect((await card(SHIBUYA)).availability).toBe("none");
  });

  it("puts the stay numbers on the Areas, the cells in StayMarkets and the hotels in their Areas", async () => {
    const result = await load();
    expect(result.exitCode).toBe(0);
    expect(result.summary!.stay).toMatchObject({ bundleDate: "2026-11-20", areas: 3, areasCleared: 0, markets: 1, hotels: { created: 3, unchanged: 0, skippedNoArea: 1 } });
    expect(log.some((l) => l.includes("stay: 3 areas, 1 cities"))).toBe(true);

    const c = await card(SHIBUYA);
    expect(c).toMatchObject({
      availability: "market",
      cityCovered: true,
      score: 59.9,
      weightCoverage: 1,
      snapshotDate: "2026-09-25",
      bundleDate: "2026-11-20",
      hotelSuggestions: 2,
      location: { centreKm: 3.2, stationKm: 3.2, radiusKm: 1.5 },
      price: { medianCad: 197.32, p25Cad: 144.16, p75Cad: 245.53, perPersonCad: 80.5, cityMedianCad: 137.41 },
      coverage: { coveredCities: 1, trippCities: 108, note: "Inside Airbnb covers 1 of 108 cities" },
    });
    expect(c.parts.map((p) => p.key)).toEqual(["value", "centrality", "walkability", "quiet", "reviews"]);
    expect(c.parts.reduce((sum, p) => sum + p.weight, 0)).toBeCloseTo(1);
    expect(c.explanation).toContain("Cheaper than 30%");
    expect(c.attribution).toContain("Inside Airbnb");
    expect(c.attribution).toContain("CC BY 4.0");
    expect(c.note).toContain("40 Inside Airbnb listings");
    // Aggregates only: nothing in the card can point at a listing or a host.
    expect(JSON.stringify(c)).not.toMatch(/listing_?id|host_?id|airbnb\.com\/rooms/i);
  });

  it("explains an area in a covered city that has no unit, and a city Inside Airbnb does not cover", async () => {
    const shinjuku = await card(SHINJUKU);
    expect(shinjuku).toMatchObject({ availability: "none", cityCovered: true, score: null, attribution: null });
    expect(shinjuku.note).toContain("not one of the areas the data run measures");
    const bj = await card(BEIJING);
    expect(bj).toMatchObject({ availability: "places", cityCovered: false, score: 58, price: null, market: null, attribution: null });
    expect(bj.note).toContain("No stay data for Beijing");
    expect(bj.note).toContain("Inside Airbnb covers 1 of 108 cities");
    expect(bj.parts.find((p) => p.key === "centrality")!.score).toBe(85);
  });

  it("serves the hotels of an Area best first, with their sources and attribution, and none for an Area without", async () => {
    const s = await suggestions(SHIBUYA);
    expect(s).toMatchObject({ areaId: SHIBUYA, areaName: "Shibuya", cityCode: "TYO", total: 2 });
    expect(s.hotels.map((x) => x.name)).toEqual(["Shibuya Grand", "Shibuya Guesthouse"]);
    expect(s.hotels[0]).toMatchObject({ stars: 4, website: "https://grand.example.com", nSources: 3, kind: "hotel", distanceKm: 0.4, sources: [{ source: "overture", licence: "CDLA-Permissive-2.0" }] });
    expect(s.hotels[1]!.sources).toEqual([{ source: "osm_lodging", licence: "ODbL-1.0" }]);
    expect(s.attributions.join(" ")).toContain("OpenStreetMap contributors");
    expect(s.attributions.join(" ")).toContain("Overture Maps Foundation");
    expect((await suggestions(SHIBUYA, "?limit=1")).hotels).toHaveLength(1);
    expect((await suggestions(SHINJUKU)).hotels).toEqual([]);
    expect((await owner.api.get(`/areas/${SHIBUYA}/hotel-suggestions?limit=0`)).status).toBe(400);
    expect((await suggestions(ASAKUSA)).hotels.map((x) => x.name)).toEqual(["Asakusa Inn"]);
  });

  it("records hotel provenance as FROM_SOURCE edges with the licence, and the area id", async () => {
    expect(await count("MATCH (h:Hotel)-[:FROM_SOURCE]->(d:DataSource) WHERE h.catalogue = true RETURN count(h) AS n")).toBe(3);
    const rows = await h.db.query<{ id: string; licence: string; areaId: string }>(
      "MATCH (h:Hotel {id: $id})-[r:FROM_SOURCE]->(d:DataSource) RETURN d.id AS id, r.licence AS licence, h.areaId AS areaId",
      { id: hShibuya2.id },
    );
    expect(rows).toEqual([{ id: "osm_lodging", licence: "ODbL-1.0", areaId: SHIBUYA }]);
    expect(await count("MATCH (h:Hotel {catalogue: true})-[:IN]->(a:Area {id: $id}) RETURN count(h) AS n", { id: SHIBUYA })).toBe(2);
  });

  it("is idempotent", async () => {
    const again = await load();
    expect(again.summary!.stay).toMatchObject({ areas: 3, markets: 1, hotels: { created: 0, refreshed: 0, unchanged: 3, removed: 0, skippedNoArea: 1 } });
    expect(await count("MATCH (h:Hotel) WHERE h.catalogue = true RETURN count(h) AS n")).toBe(3);
    expect(await count("MATCH (m:StayMarket) RETURN count(m) AS n")).toBe(1);
    expect(await count("MATCH (:Hotel)-[r:IN]->(:Area) RETURN count(r) AS n")).toBe(3);
    expect(await count("MATCH (h:Hotel)-[r:FROM_SOURCE]->(:DataSource) WHERE h.catalogue = true RETURN count(r) AS n")).toBe(3);
    expect((await suggestions(SHIBUYA)).total).toBe(2);
  });
});

describe("the map layer", () => {
  it("serves a city's cells with a colour scale and the attribution", async () => {
    const res = await cells("city=TYO");
    expect(res.status).toBe(200);
    expect(res.body.cells.map((c) => c.id).sort()).toEqual([cellA.unit_id, cellB.unit_id, cellC.unit_id].sort());
    expect(res.body).toMatchObject({ total: 3, truncated: false });
    expect(res.body.cities).toEqual([{ cityCode: "TYO", cityName: "Tokyo", snapshotDate: "2026-09-25", cityMedianCad: 137.41, scale: { low: 120, high: 280 } }]);
    expect(res.body.attribution).toContain("Inside Airbnb");
    expect(res.body.cells.find((c) => c.id === cellA.unit_id)).toEqual({ id: cellA.unit_id, city: "TYO", lat: 35.66, lon: 139.7, price: 100, pp: 50, listings: 12, score: 55 });
  });

  it("trims to a viewport and caps the page", async () => {
    const view = await cells("bbox=139.6,35.6,139.9,35.8");
    expect(view.body.cells.map((c) => c.id).sort()).toEqual([cellA.unit_id, cellB.unit_id].sort());
    expect(view.body.cities[0]!.scale).toEqual({ low: 120, high: 280 });
    const far = await cells("bbox=0,0,1,1");
    expect(far.body).toMatchObject({ cells: [], total: 0, cities: [], attribution: null });
    const capped = await cells("city=TYO&limit=2");
    expect(capped.body).toMatchObject({ total: 3, truncated: true });
    expect(capped.body.cells.map((c) => c.listings)).toEqual([12, 9]);
    expect((await cells("city=OSA")).body.cells).toEqual([]);
  });

  it("offers the neighbourhoods as a layer of their own", async () => {
    const res = await cells("city=TYO&layer=neighbourhood");
    expect(res.body.cells).toEqual([{ id: "TYO/Shibuya Ku", name: "Shibuya Ku", city: "TYO", lat: 35.66, lon: 139.7, price: 150, pp: null, listings: 40, score: 60 }]);
  });

  it("needs a city or a viewport, and sane limits", async () => {
    expect((await owner.api.get(`/trips/${TRIP}/stay/cells`)).status).toBe(400);
    expect((await cells("bbox=1,2,3")).status).toBe(400);
    expect((await cells("city=TYO&limit=99999")).status).toBe(400);
    expect((await cells("city=TYO&layer=listing")).status).toBe(400);
  });
});

describe("who can read it", () => {
  it("needs a sign-in, and membership of the trip that owns the Area", async () => {
    expect((await client(h.app).get(`/areas/${SHIBUYA}/stay`)).status).toBe(401);
    expect((await client(h.app).get(`/trips/${TRIP}/stay/cells?city=TYO`)).status).toBe(401);
    expect((await client(h.app).get(`/areas/${SHIBUYA}/hotel-suggestions`)).status).toBe(401);
    expect((await stranger.api.get(`/areas/${SHIBUYA}/stay`)).status).toBe(404);
    expect((await stranger.api.get(`/trips/${TRIP}/stay/cells?city=TYO`)).status).toBe(404);
    expect((await stranger.api.get(`/areas/${SHIBUYA}/hotel-suggestions`)).status).toBe(404);
    expect((await owner.api.get(`/areas/area-nope/stay`)).status).toBe(404);
  });

  it("lets viewers and editors read, and the read-only demo visitor too", async () => {
    expect((await viewer.api.get<AreaStay>(`/areas/${SHIBUYA}/stay`)).body.score).toBe(59.9);
    expect((await editor.api.get(`/areas/${SHIBUYA}/hotel-suggestions`)).status).toBe(200);
    expect((await cells("city=TYO", viewer)).status).toBe(200);
    const demo = client(h.app, (await client(h.app).post("/auth/demo")).body.token);
    expect((await demo.get(`/areas/${SHIBUYA}/stay`)).status).toBe(200);
  });
});

describe("what the group wrote stays", () => {
  let ownHotel = "";

  it("keeps the group's own hotels apart from the suggestions", async () => {
    const created = await editor.api.post<Hotel>("/hotels", { tripId: TRIP, areaId: SHIBUYA, name: "Our Shibuya Hotel", priceCadPerNight: 180 });
    expect(created.status).toBe(201);
    ownHotel = created.body.id;
    const list = (await viewer.api.get<Hotel[]>(`/trips/${TRIP}/hotels?city=TYO`)).body;
    expect(list.map((x) => x.name)).toEqual(["Our Shibuya Hotel"]);
    const areas = (await viewer.api.get<Area[]>(`/cities/TYO/areas?tripId=${TRIP}`)).body;
    expect(areas.find((a) => a.id === SHIBUYA)!.hotelCount).toBe(1);
    expect(areas.find((a) => a.id === ASAKUSA)!.hotelCount).toBe(0);
    // A suggestion is not a hotel anyone can open: no trip owns it.
    expect((await editor.api.put(`/hotels/${hShibuya1.id}/vote`, { value: 1 })).status).toBe(404);
  });

  it("an Area with only suggestions can be deleted, taking them with it; one with the group's hotels cannot", async () => {
    expect((await editor.api.del(`/areas/${SHIBUYA}`)).status).toBe(400);
    const area = await editor.api.post<Area>("/areas", { tripId: TRIP, cityCode: "TYO", name: "Temporary Area" });
    const id = area.body.id;
    writeStayBundle(root, {
      date: "2026-11-21",
      units: [tokyo, shibuya, asakusa, beijing, cellA, marketArea(id, "TYO", "Temporary Area")],
      hotels: [hShibuya1, hShibuya2, hAsakusa, hotel(id, "TYO", { name: "Temporary Hotel" })],
    });
    expect((await load({ date: "2026-11-21" })).exitCode).toBe(0);
    expect((await suggestions(id)).hotels.map((x) => x.name)).toEqual(["Temporary Hotel"]);
    expect((await editor.api.del(`/areas/${id}`)).status).toBe(204);
    expect(await count("MATCH (h:Hotel {catalogue: true}) WHERE h.areaId = $id RETURN count(h) AS n", { id })).toBe(0);
    expect(await count("MATCH (h:Hotel {id: $id}) RETURN count(h) AS n", { id: ownHotel })).toBe(1);
  });

  it("a newer bundle refreshes, removes and clears, and never touches the group's hotel or its stay", async () => {
    const stops = (await owner.api.get<{ stops: { id: string; city: { code: string } }[]; route: { version: number } }>(`/routes/route-main`)).body;
    const tyo = stops.stops.find((s) => s.city.code === "TYO")!;
    const shortlisted = await editor.api.put(`/stops/${tyo.id}/stays/${ownHotel}`, { status: "chosen", version: stops.route.version });
    expect(shortlisted.status).toBe(200);

    // Shibuya drops Guesthouse, Grand gets a fifth star, the Asakusa unit and hotel go, Tokyo gets one more cell.
    const grand = { ...hShibuya1, stars: 5 };
    writeStayBundle(root, {
      date: "2026-11-22",
      units: [tokyo, { ...shibuya, stay_score: 61 }, beijing, cellA, cellB, cell("8864a41617fffff", "TYO", 35.62, 139.72)],
      hotels: [grand],
    });
    const res = await load({ date: "2026-11-22" });
    expect(res.summary!.stay).toMatchObject({ areas: 2, areasCleared: 1, markets: 1, cells: 3, hotels: { created: 0, refreshed: 1, unchanged: 0, removed: 2, skippedNoArea: 0 } });

    expect((await card(SHIBUYA)).score).toBe(61);
    expect((await card(ASAKUSA)).availability).toBe("none");
    expect((await suggestions(SHIBUYA)).hotels.map((x) => [x.name, x.stars])).toEqual([["Shibuya Grand", 5]]);
    expect((await suggestions(ASAKUSA)).hotels).toEqual([]);
    expect((await cells("city=TYO")).body.total).toBe(3);

    const mine = (await viewer.api.get<Hotel[]>(`/trips/${TRIP}/hotels?city=TYO`)).body;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: ownHotel, name: "Our Shibuya Hotel", priceCadPerNight: 180, stays: [expect.objectContaining({ status: "chosen" })] });
    expect(await count("MATCH (h:Hotel) RETURN count(h) AS n")).toBe(2); // the group's own plus Shibuya Grand
  });

  it("a city that drops out of the bundle loses its map layer", async () => {
    writeStayBundle(root, { date: "2026-11-23", units: [beijing], hotels: [] });
    const res = await load({ date: "2026-11-23" });
    expect(res.summary!.stay).toMatchObject({ markets: 0, areas: 1, areasCleared: 1, hotels: { removed: 1 } });
    expect((await cells("city=TYO")).body.cells).toEqual([]);
    expect(await count("MATCH (m:StayMarket) RETURN count(m) AS n")).toBe(0);
    expect((await card(SHIBUYA)).availability).toBe("none");
    expect((await card(BEIJING)).availability).toBe("places");
    expect((await card(BEIJING)).coverage).toMatchObject({ coveredCities: 0, trippCities: 108 });
  });
});

describe("bundles without stay data, and bad ones", () => {
  it("a bundle without stay tables loads and leaves the stay data alone", async () => {
    writeBundle(root, { date: "2026-11-24", places: [place({ name: "Plain Place", city_code: "TYO" })] });
    const res = await load({ date: "2026-11-24" });
    expect(res.exitCode).toBe(0);
    expect(res.summary!.stay).toBeNull();
    expect((await card(BEIJING)).availability).toBe("places");
  });

  it("skips a newest bundle whose stay file is damaged and loads the one before", async () => {
    writeStayBundle(root, { ...FIRST, date: "2026-12-30", corrupt: "units" });
    const res = await load();
    expect(res.summary!.bundleDate).toBe("2026-11-24");
    expect(log.some((l) => l.includes("skipped bundle 2026-12-30") && l.includes("stay_unit.jsonl.gz"))).toBe(true);
  });
});

describe("the Data page", () => {
  it("shows the stay section, snapshot dates, attribution and the stay checks", async () => {
    writeStayBundle(root, { ...FIRST, date: "2026-11-25", checks: { passed: true, results: [{ name: "stay.unit.unique_ids", status: "pass", detail: "unit ids are unique per kind" }, { name: "stay.airbnb.snapshot_age", status: "warn", detail: "one snapshot is 60 days old" }] } });
    expect((await load({ date: "2026-11-25" })).exitCode).toBe(0);
    const res = await client(h.app).get<DataSourcesResponse>("/data/sources");
    expect(res.status).toBe(200);
    const stay = res.body.stay!;
    expect(stay).toMatchObject({ bundleDate: "2026-11-25", coverage: { coveredCities: 1, trippCities: 108, note: "Inside Airbnb covers 1 of 108 cities" }, hotels: { inGraph: 3, perAreaCap: 150 } });
    expect(stay.cities).toEqual([{ cityCode: "TYO", name: "Tokyo", snapshotDate: "2026-09-25", listings: 115, pricedListings: 106, medianPriceCad: 137.41 }]);
    expect(stay.attribution).toContain("Data from Inside Airbnb (insideairbnb.com), CC BY 4.0");
    expect(stay.licence).toBe("CC BY 4.0");
    expect(stay.checks!.results.map((r) => r.status)).toEqual(["pass", "warn"]);
    expect(stay.weights.centrality).toBe(0.3);
    const byId = new Map(res.body.sources.map((s) => [s.id, s]));
    expect(byId.get("osm_lodging")).toMatchObject({ hotels: 1, licence: "ODbL-1.0" });
    expect(byId.get("overture")!.hotels).toBe(2);
    expect(byId.get("insideairbnb")!.attribution).toContain("Inside Airbnb");
  });
});

describe("the bundle the pipeline's golden test writes", () => {
  it("loads its stay tables onto the seeded Areas, twice", async () => {
    const store = localStore(GOLDEN_BUNDLE_DIR);
    const first = await load({ store });
    expect(first.exitCode).toBe(0);
    expect(first.summary!.stay).toMatchObject({ areas: 19, markets: 2, hotels: { created: 7, skippedNoArea: 0 } });
    const c = await card(SHIBUYA);
    expect(c).toMatchObject({ availability: "market", cityCovered: true, snapshotDate: "2026-09-25" });
    expect(c.parts.find((p) => p.key === "centrality")!.score).not.toBeNull();
    expect(c.coverage!.note).toBe("Inside Airbnb covers 2 of 108 cities");
    expect((await card("area-bjs-sanlitun")).availability).toBe("none");
    expect((await suggestions("area-tyo-asakusa")).total).toBe(3);
    const again = await load({ store });
    expect(again.summary!.stay).toMatchObject({ hotels: { created: 0, refreshed: 0, unchanged: 7, removed: 0 } });
    const layer = (await cells("city=SIN")).body;
    expect(layer.cells.length).toBeGreaterThan(0);
    expect(layer.cities[0]).toMatchObject({ cityCode: "SIN", snapshotDate: "2026-09-23" });
  });
});
