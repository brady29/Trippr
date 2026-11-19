import type { Area, GraphJSON, Hotel, Hub, LegPrivate, RouteView } from "@trippr/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateGraphExplorer } from "../src/db/explorer-migration";
import { createRepositories } from "../src/repositories";
import { buildGraph } from "../src/services/graph";
import { client, SEED_DIR, signIn, startHarness, type Harness } from "./harness";

let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;
let editor: Awaited<ReturnType<typeof signIn>>;
let viewer: Awaited<ReturnType<typeof signIn>>;
let demo: ReturnType<typeof client>;

const TRIP = "asia-2027";
const MAIN = "route-main";
const SHANGHAI = "route-with-shanghai";
const SECRET_REF = "PNR-ZX81QK";

const count = async (cypher: string) => Number(((await h.db.query<{ n: number }>(cypher))[0] ?? { n: 0 }).n);
const counts = async () => ({
  hubs: await count("MATCH (n:Hub) RETURN count(n) AS n"),
  areas: await count("MATCH (n:Area) RETURN count(n) AS n"),
  legs: await count("MATCH (n:Leg) RETURN count(n) AS n"),
  hubLinks: await count("MATCH (:Hub)-[l:LINK]->(:Hub) RETURN count(l) AS n"),
  serves: await count("MATCH (:Hub)-[s:SERVES]->(:City) RETURN count(s) AS n"),
});

const stopIn = (view: RouteView, city: string) => view.stops.find((s) => s.city.code === city)!;

beforeAll(async () => {
  h = await startHarness();
  owner = await signIn(h.app, "Brady");
  editor = await signIn(h.app, "Editor Friend");
  viewer = await signIn(h.app, "Viewer Friend");
  await owner.api.post(`/invites/${h.ownerInvite}/accept`);
  const e = await owner.api.post(`/trips/${TRIP}/invites`, { role: "editor" });
  await editor.api.post(`/invites/${e.body.token}/accept`);
  const v = await owner.api.post(`/trips/${TRIP}/invites`, { role: "viewer" });
  await viewer.api.post(`/invites/${v.body.token}/accept`);
  demo = client(h.app, (await client(h.app).post("/auth/demo")).body.token);
});

afterAll(async () => {
  await h?.close();
});

describe("migration", () => {
  it("adds hubs, areas and one idea leg per stop where a hub exists", async () => {
    expect(h.explorer).toMatchObject({ ran: true, hubs: 22, areas: 20 });
    const main = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const tyo = stopIn(main, "TYO");
    expect(tyo.legs).toEqual([
      expect.objectContaining({ mode: "flight", status: "idea", from: expect.objectContaining({ id: "YYZ", kind: "airport" }), to: expect.objectContaining({ id: "HND" }) }),
    ]);
    expect(stopIn(main, "SIA").legs[0]).toMatchObject({ mode: "hsr", from: { id: "stn-beijing-west" }, to: { id: "stn-xian-north" } });
    expect(stopIn(main, "HKG").legs[0]).toMatchObject({ mode: "train", from: { id: "stn-futian" }, to: { id: "stn-west-kowloon" } });
    // A boat into Komodo has no hub, so no leg.
    const shanghai = (await owner.api.get<RouteView>(`/routes/${SHANGHAI}`)).body;
    expect(stopIn(shanghai, "KOM").legs).toEqual([]);
    expect(stopIn(shanghai, "SHA").legs[0]).toMatchObject({ to: { id: "stn-shanghai-hongqiao" } });
  });

  it("retires the Pudong and Longyang Road city nodes and links the hubs instead", async () => {
    expect(await count("MATCH (c:City) WHERE c.code IN ['PVG', 'LYD'] RETURN count(c) AS n")).toBe(0);
    expect(await count("MATCH (:Hub {hubId: 'PVG'})-[l:LINK {mode: 'maglev'}]->(:Hub {hubId: 'stn-longyang-road'}) RETURN count(l) AS n")).toBe(1);
    // City-level rail links are copied to the default stations.
    expect(await count("MATCH (:Hub {hubId: 'stn-xian-north'})-[l:LINK {mode: 'hsr'}]->(:Hub {hubId: 'stn-chongqing-west'}) RETURN count(l) AS n")).toBe(1);
  });

  it("is idempotent: running it again, even forced, changes nothing", async () => {
    const before = await counts();
    expect(await migrateGraphExplorer(h.db, { seedDir: SEED_DIR })).toMatchObject({ ran: false });
    expect(await migrateGraphExplorer(h.db, { seedDir: SEED_DIR, force: true })).toMatchObject({ ran: true, legsCreated: 0 });
    expect(await counts()).toEqual(before);
  });
});

describe("hubs", () => {
  it("searches stations and airports by name, code and city", async () => {
    const ckg = (await viewer.api.get<Hub[]>("/hubs?city=CKG")).body;
    expect(ckg.map((x) => x.id).sort()).toEqual(["stn-chongqing-north", "stn-chongqing-west"]);
    const hkg = (await viewer.api.get<Hub[]>("/hubs?q=hkg&kind=airport")).body;
    expect(hkg[0]).toMatchObject({ id: "HKG", kind: "airport", cityCode: "HKG" });
    // Labuan Bajo's airport also serves Komodo.
    expect((await viewer.api.get<Hub[]>("/hubs?city=KOM")).body.map((x) => x.id)).toEqual(["LBJ"]);
  });
});

describe("legs", () => {
  let legId = "";

  it("adds a leg with a booking reference and returns the route", async () => {
    const view = (await editor.api.get<RouteView>(`/routes/${SHANGHAI}`)).body;
    const lbj = stopIn(view, "LBJ");
    const res = await editor.api.post<RouteView>(`/stops/${lbj.id}/legs`, {
      mode: "flight",
      from: { kind: "airport", id: "SGN" },
      to: { kind: "airport", id: "LBJ" },
      operator: "VietJet",
      number: "VJ 999",
      departAt: `${lbj.arrive}T08:05+07:00`,
      priceCad: 240,
      status: "booked",
      bookingRef: SECRET_REF,
      seat: "12A",
      version: view.route.version,
    });
    expect(res.status).toBe(201);
    expect(res.body.route.version).toBe(view.route.version + 1);
    const legs = stopIn(res.body, "LBJ").legs;
    const added = legs.find((l) => l.number === "VJ 999")!;
    legId = added.id;
    expect(added).toMatchObject({ status: "booked", priceCad: 240, from: { id: "SGN" }, to: { id: "LBJ" } });
    expect(JSON.stringify(res.body)).not.toContain(SECRET_REF);
    // Priced legs replace the stop's travel estimate in the budget.
    expect(res.body.budget.perPerson.travel - view.budget.perPerson.travel).toBe(240);
  });

  it("keeps booking references and seats away from viewers and the demo", async () => {
    const asViewer = await viewer.api.get(`/routes/${SHANGHAI}`);
    expect(asViewer.text).not.toContain(SECRET_REF);
    expect(asViewer.text).not.toContain("12A");
    expect((await viewer.api.get(`/legs/${legId}/private`)).status).toBe(403);
    expect((await demo.get(`/legs/${legId}/private`)).status).toBe(403);
    const graph = await viewer.api.get(`/trips/${TRIP}/graph`);
    expect(graph.text).not.toContain(SECRET_REF);
    expect((await demo.get(`/trips/${TRIP}/graph`)).text).not.toContain(SECRET_REF);
    const priv = await editor.api.get<LegPrivate>(`/legs/${legId}/private`);
    expect(priv.body).toEqual({ id: legId, bookingRef: SECRET_REF, seat: "12A" });
  });

  it("edits a leg, re-points its hubs, and refuses a stale version", async () => {
    const view = (await editor.api.get<RouteView>(`/routes/${SHANGHAI}`)).body;
    const res = await editor.api.patch<RouteView>(`/legs/${legId}`, {
      from: { kind: "airport", id: "DPS" },
      priceCad: 180,
      seat: null,
      version: view.route.version,
    });
    expect(res.status).toBe(200);
    const leg = stopIn(res.body, "LBJ").legs.find((l) => l.id === legId)!;
    expect(leg).toMatchObject({ priceCad: 180, from: { id: "DPS" }, operator: "VietJet" });
    expect((await editor.api.get<LegPrivate>(`/legs/${legId}/private`)).body.seat).toBeNull();
    const stale = await editor.api.patch(`/legs/${legId}`, { priceCad: 1, version: view.route.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect((await editor.api.patch(`/legs/${legId}`, { from: { kind: "station", id: "nowhere" }, version: res.body.route.version })).status).toBe(400);
  });

  it("warns when a ticket departs on the wrong day", async () => {
    const view = (await editor.api.get<RouteView>(`/routes/${SHANGHAI}`)).body;
    const res = await editor.api.patch<RouteView>(`/legs/${legId}`, { departAt: "2027-01-01T08:00+07:00", version: view.route.version });
    expect(res.body.checks.checks.find((c) => c.kind === "leg-day")).toMatchObject({ level: "warn", legId });
  });

  it("deletes a leg with ?version= (editors only)", async () => {
    const view = (await editor.api.get<RouteView>(`/routes/${SHANGHAI}`)).body;
    expect((await viewer.api.del(`/legs/${legId}?version=${view.route.version}`)).status).toBe(403);
    expect((await editor.api.del(`/legs/${legId}?version=${view.route.version - 1}`)).status).toBe(409);
    const res = await editor.api.del<RouteView>(`/legs/${legId}?version=${view.route.version}`);
    expect(res.status).toBe(200);
    expect(stopIn(res.body, "LBJ").legs.map((l) => l.id)).not.toContain(legId);
  });
});

describe("areas and hotels", () => {
  let areaId = "";
  let hotelA = "";
  let hotelB = "";

  it("lists the suggested areas for a city and adds a new one", async () => {
    const tokyo = (await viewer.api.get<Area[]>(`/cities/TYO/areas?tripId=${TRIP}`)).body;
    expect(tokyo.map((a) => a.name).sort()).toEqual(["Asakusa", "Shibuya", "Shinjuku"]);
    expect((await viewer.api.post("/areas", { tripId: TRIP, cityCode: "TYO", name: "Ginza" })).status).toBe(403);
    const created = await editor.api.post<Area>("/areas", {
      tripId: TRIP,
      cityCode: "TYO",
      name: "Ueno",
      vibes: ["budget", "transit"],
      lat: 35.712,
      lon: 139.776,
    });
    expect(created.status).toBe(201);
    areaId = created.body.id;
    expect(created.body).toMatchObject({ name: "Ueno", vibes: ["budget", "transit"], hotelCount: 0, cityCode: "TYO" });
    const patched = await editor.api.patch<Area>(`/areas/${areaId}`, { note: "Near the park", lat: null });
    expect(patched.body).toMatchObject({ note: "Near the park", lat: null, lon: 139.776 });
    const voted = await viewer.api.put<Area>(`/areas/${areaId}/vote`, { value: 1 });
    expect(voted.body).toMatchObject({ votes: 1, myVote: 1 });
  });

  it("adds hotels to an area and lists them", async () => {
    const a = await editor.api.post<Hotel>("/hotels", {
      tripId: TRIP,
      areaId,
      name: "Ueno Capsule & Rooms",
      priceCadPerNight: 200,
      lat: 35.711,
      lon: 139.777,
    });
    expect(a.status).toBe(201);
    hotelA = a.body.id;
    expect(a.body).toMatchObject({ priceBasis: "room", sleeps: 2, areaName: "Ueno", cityCode: "TYO", stays: [] });
    const b = await editor.api.post<Hotel>("/hotels", { tripId: TRIP, areaId, name: "Hostel Ueno", priceCadPerNight: 45, priceBasis: "person" });
    hotelB = b.body.id;
    const list = (await viewer.api.get<Hotel[]>(`/trips/${TRIP}/hotels?city=TYO`)).body;
    expect(list.map((x) => x.id).sort()).toEqual([hotelA, hotelB].sort());
    expect((await viewer.api.put<Hotel>(`/hotels/${hotelA}/vote`, { value: -1 })).body).toMatchObject({ votes: -1, myVote: -1 });
    // An area with hotels cannot be deleted.
    expect((await editor.api.del(`/areas/${areaId}`)).status).toBe(400);
  });

  it("chooses one hotel per stop, and the budget uses its per-person price", async () => {
    let view = (await editor.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const tyo = stopIn(view, "TYO");
    let res = await editor.api.put<RouteView>(`/stops/${tyo.id}/stays/${hotelA}`, { status: "chosen", version: view.route.version });
    expect(res.status).toBe(200);
    view = res.body;
    expect(stopIn(view, "TYO").stays).toEqual([
      expect.objectContaining({ status: "chosen", perPersonCadPerNight: 100, hotel: expect.objectContaining({ id: hotelA }) }),
    ]);
    expect(view.budget.perPerson.stay).toBe(400); // 4 nights × $100
    // Choosing the other hotel demotes the first to the shortlist.
    res = await editor.api.put<RouteView>(`/stops/${tyo.id}/stays/${hotelB}`, { status: "chosen", version: view.route.version });
    view = res.body;
    const stays = stopIn(view, "TYO").stays;
    expect(stays.find((s) => s.hotel.id === hotelB)!.status).toBe("chosen");
    expect(stays.find((s) => s.hotel.id === hotelA)!.status).toBe("shortlist");
    expect(view.budget.perPerson.stay).toBe(180); // 4 × $45 per person
    // A stale version is refused.
    expect((await editor.api.put(`/stops/${tyo.id}/stays/${hotelA}`, { status: "chosen", version: 0 })).status).toBe(409);
  });

  it("refuses a hotel from another city", async () => {
    const view = (await editor.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const bjs = stopIn(view, "BJS");
    const res = await editor.api.put(`/stops/${bjs.id}/stays/${hotelA}`, { status: "shortlist", version: view.route.version });
    expect(res.status).toBe(400);
  });

  it("records booked dates and warns when the stop moves", async () => {
    let view = (await editor.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const tyo = stopIn(view, "TYO");
    view = (await editor.api.put<RouteView>(`/stops/${tyo.id}/stays/${hotelB}`, { status: "booked", rooms: 3, version: view.route.version })).body;
    expect(view.checks.checks.some((c) => c.kind === "stay-dates")).toBe(false);
    view = (await editor.api.patch<RouteView>(`/stops/${tyo.id}`, { nights: 5, version: view.route.version })).body;
    expect(view.checks.checks.find((c) => c.kind === "stay-dates")).toMatchObject({ level: "warn", hotelId: hotelB });
    view = (await editor.api.patch<RouteView>(`/stops/${tyo.id}`, { nights: 4, version: view.route.version })).body;
    expect(view.checks.checks.some((c) => c.kind === "stay-dates")).toBe(false);
  });

  it("copies legs and stays when a route is duplicated", async () => {
    const source = (await editor.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const copy = (await editor.api.post<RouteView>(`/trips/${TRIP}/routes`, { fromRouteId: MAIN, name: "Main with hotels" })).body;
    expect(copy.stops.map((s) => s.legs.length)).toEqual(source.stops.map((s) => s.legs.length));
    expect(copy.stops[0]!.legs[0]!.id).not.toBe(source.stops[0]!.legs[0]!.id);
    expect(stopIn(copy, "TYO").stays.map((s) => [s.hotel.id, s.status])).toEqual(stopIn(source, "TYO").stays.map((s) => [s.hotel.id, s.status]));
    expect(copy.budget.perPerson.stay).toBe(source.budget.perPerson.stay);
  });

  it("removes a stay with ?version=", async () => {
    const view = (await editor.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const tyo = stopIn(view, "TYO");
    const res = await editor.api.del<RouteView>(`/stops/${tyo.id}/stays/${hotelA}?version=${view.route.version}`);
    expect(res.status).toBe(200);
    expect(stopIn(res.body, "TYO").stays.map((s) => s.hotel.id)).not.toContain(hotelA);
    expect((await editor.api.del(`/stops/${tyo.id}/stays/${hotelA}?version=${res.body.route.version}`)).status).toBe(404);
  });
});

describe("graph export", () => {
  it("exports the whole trip as GraphJSON", async () => {
    const res = await viewer.api.get<GraphJSON>(`/trips/${TRIP}/graph`);
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBeTruthy();
    const g = res.body;
    expect(g.meta).toMatchObject({ tripId: TRIP, scope: "trip", truncated: false, tripStart: "2027-05-10" });
    expect(g.meta.routes.length).toBeGreaterThanOrEqual(2);
    const types = new Set(g.nodes.map((n) => n.type));
    for (const t of ["trip", "route", "stop", "city", "country", "activity", "area", "hotel", "station", "airport", "leg"]) {
      expect(types.has(t as never)).toBe(true);
    }
    for (const [type, count] of Object.entries(g.meta.counts)) {
      expect(g.nodes.filter((n) => n.type === type).length).toBe(count);
    }
    // Every edge joins two nodes that are in the export.
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    // Prefixed ids, coordinates on placeable nodes, colour tags on activities.
    expect(ids.has("city:CKG")).toBe(true);
    expect(ids.has("apt:HND")).toBe(true);
    expect(ids.has("stn:stn-xian-north")).toBe(true);
    expect(ids.has("act:act-liziba")).toBe(true);
    for (const n of g.nodes.filter((n) => ["city", "stop", "station", "airport"].includes(n.type))) {
      expect(typeof n.lat).toBe("number");
      expect(typeof n.lon).toBe("number");
    }
    const liziba = g.nodes.find((n) => n.id === "act:act-liziba")!;
    expect(liziba.style).toMatchObject({ tag: "tech", planned: true });
    expect(liziba.style.routes).toContain(MAIN);
    expect(g.nodes.find((n) => n.id === "act:act-npb")!.style).toMatchObject({ tag: "sport", fixedDate: true });
    // NEXT edges follow each route's stop order.
    expect(g.edges.filter((e) => e.type === "NEXT").length).toBe(
      g.nodes.filter((n) => n.type === "stop").length - g.nodes.filter((n) => n.type === "route").length,
    );
  });

  it("answers an unchanged graph with 304", async () => {
    const first = await viewer.api.get(`/trips/${TRIP}/graph?scope=route&routeId=${MAIN}`);
    const etag = String(first.headers["etag"]);
    const res = await h.app.inject({
      method: "GET",
      url: `/trips/${TRIP}/graph?scope=route&routeId=${MAIN}`,
      headers: { authorization: `Bearer ${viewer.token}`, "if-none-match": etag },
    });
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe("");
  });

  it("scopes to one route and to one city", async () => {
    const route = (await viewer.api.get<GraphJSON>(`/trips/${TRIP}/graph?scope=route&routeId=${MAIN}`)).body;
    expect(route.nodes.filter((n) => n.type === "stop").length).toBe(11);
    expect(route.nodes.some((n) => n.type === "trip")).toBe(false);
    // Bund is in Shanghai, which Main skips.
    expect(route.nodes.some((n) => n.id === "act:act-bund")).toBe(false);

    const city = (await viewer.api.get<GraphJSON>(`/trips/${TRIP}/graph?scope=city&city=CKG`)).body;
    expect(city.nodes.filter((n) => n.type === "city").map((n) => n.id)).toEqual(["city:CKG"]);
    // Every station serving the city, plus the far end of legs into it (Xi'an North).
    expect(city.nodes.filter((n) => n.type === "station").map((n) => n.id)).toEqual(
      expect.arrayContaining(["stn:stn-chongqing-north", "stn:stn-chongqing-west", "stn:stn-xian-north"]),
    );
    expect(city.nodes.filter((n) => n.type === "activity").every((n) => n.cityCode === "CKG")).toBe(true);
    expect((await viewer.api.get(`/trips/${TRIP}/graph?scope=city`)).status).toBe(400);
  });

  it("filters node types", async () => {
    const g = (await viewer.api.get<GraphJSON>(`/trips/${TRIP}/graph?types=city,activity`)).body;
    expect(new Set(g.nodes.map((n) => n.type))).toEqual(new Set(["city", "activity"]));
  });

  it("truncates by priority over the limits, keeping the route skeleton", async () => {
    const repos = createRepositories(h.db);
    const g = (await buildGraph(repos, { tripId: TRIP, userId: viewer.id, scope: "trip" }, { nodes: 60, edges: 80 }))!;
    expect(g.meta.truncated).toBe(true);
    expect(g.nodes.length).toBeLessThanOrEqual(60);
    expect(g.edges.length).toBeLessThanOrEqual(80);
    const full = (await buildGraph(repos, { tripId: TRIP, userId: viewer.id, scope: "trip" }))!;
    expect(g.nodes.filter((n) => n.type === "stop").length).toBe(full.nodes.filter((n) => n.type === "stop").length);
  });

  it("expands one node's neighbourhood", async () => {
    const res = await viewer.api.get<GraphJSON>(`/trips/${TRIP}/graph/nodes/city:CKG/neighbours?limit=100`);
    expect(res.status).toBe(200);
    expect(res.body.nodes.map((n) => n.id)).toContain("act:act-liziba");
    expect(res.body.edges.every((e) => e.source === "city:CKG" || e.target === "city:CKG")).toBe(true);
    expect((await viewer.api.get(`/trips/${TRIP}/graph/nodes/city:NOPE/neighbours`)).status).toBe(404);
  });

  it("hides the graph from non-members", async () => {
    const stranger = await signIn(h.app, "Stranger");
    expect((await stranger.api.get(`/trips/${TRIP}/graph`)).status).toBe(404);
  });
});
