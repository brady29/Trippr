import type { CompareResult, LibraryActivity, PathResult, RouteView, StopLibrary, TripDetail } from "@trippr/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createGraphClient } from "../src/db";
import { client, signIn, startHarness, type Harness } from "./harness";

let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;
let editor: Awaited<ReturnType<typeof signIn>>;
let viewer: Awaited<ReturnType<typeof signIn>>;
let stranger: Awaited<ReturnType<typeof signIn>>;

const MAIN = "route-main";
const SHANGHAI = "route-with-shanghai";
const TRIP = "asia-2027";

beforeAll(async () => {
  h = await startHarness();
  owner = await signIn(h.app, "Brady");
  editor = await signIn(h.app, "Editor Friend");
  viewer = await signIn(h.app, "Viewer Friend");
  stranger = await signIn(h.app, "Stranger");
});

afterAll(async () => {
  await h?.close();
});

describe("health and errors", () => {
  it("reports the database as up", async () => {
    const res = await client(h.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, db: "up" });
  });

  it("uses one error shape", async () => {
    const res = await client(h.app).get("/trips");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    const missing = await owner.api.get("/nope");
    expect(missing.body.error.code).toBe("not_found");
  });

  it("rejects invalid bodies with 400", async () => {
    const res = await owner.api.post("/trips", { name: "", startDate: "2027-02-30" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("pings a brand-new, empty database (regression: read-only queries fail on a missing FalkorDB graph)", async () => {
    const config = loadConfig({
      ...process.env,
      FALKORDB_GRAPH: `trippr_empty_${Date.now()}`,
      APP_JWT_SECRET: "test-secret-test-secret-test-secret-123",
    });
    const fresh = await createGraphClient(config);
    try {
      expect(await fresh.ping()).toBe(true);
    } finally {
      await fresh.dropAll().catch(() => {});
      await fresh.close();
    }
  });

  it("rejects forged tokens", async () => {
    const res = await client(h.app, `${owner.token.slice(0, -4)}abcd`).get("/trips");
    expect(res.status).toBe(401);
  });
});

describe("seed", () => {
  it("loads both real routes, the reference data and an owner invite", () => {
    expect(h.seed.routesSeeded).toEqual([MAIN, SHANGHAI]);
    expect(h.seed.counts).toMatchObject({ countries: 14, activities: 41 });
    expect(h.seed.ownerInvite?.token).toBe(h.ownerInvite);
  });

  it("stores one LINK edge per direction with the right mode (regression: FalkorDB < 4.22 shuffled MERGE properties)", async () => {
    const rows = await h.db.query<{ to: string; mode: string; minutes: number }>(
      "MATCH (:City {code: 'CKG'})-[l:LINK]->(b:City) RETURN b.code AS to, l.mode AS mode, l.minutes AS minutes ORDER BY to, mode",
    );
    expect(rows).toEqual([
      { to: "CAN", mode: "flight", minutes: 135 },
      { to: "CAN", mode: "hsr", minutes: 345 },
      { to: "CTU", mode: "hsr", minutes: 65 },
      { to: "SIA", mode: "hsr", minutes: 280 },
    ]);
  });
});

describe("invites and roles", () => {
  it("hides the trip from non-members", async () => {
    expect((await stranger.api.get(`/trips/${TRIP}`)).status).toBe(404);
    expect((await stranger.api.get(`/routes/${MAIN}`)).status).toBe(404);
  });

  it("lets the first user claim ownership with the seeded owner invite (single use)", async () => {
    const preview = await client(h.app).get(`/invites/${h.ownerInvite}`);
    expect(preview.body).toMatchObject({ role: "owner", expired: false, trip: { name: "Asia 2027" } });
    const res = await owner.api.post(`/invites/${h.ownerInvite}/accept`);
    expect(res.body).toEqual({ tripId: TRIP, role: "owner" });
    expect((await stranger.api.post(`/invites/${h.ownerInvite}/accept`)).status).toBe(404);
  });

  it("creates editor and viewer invite links (owner only)", async () => {
    expect((await editor.api.post(`/trips/${TRIP}/invites`, { role: "editor" })).status).toBe(404);
    const editorInvite = await owner.api.post(`/trips/${TRIP}/invites`, { role: "editor" });
    expect(editorInvite.status).toBe(201);
    expect(editorInvite.body.url).toContain(`/invite/${editorInvite.body.token}`);
    expect((await editor.api.post(`/invites/${editorInvite.body.token}/accept`)).body.role).toBe("editor");

    const viewerInvite = await owner.api.post(`/trips/${TRIP}/invites`, { role: "viewer" });
    expect((await viewer.api.post(`/invites/${viewerInvite.body.token}/accept`)).body.role).toBe("viewer");
    // Accepting a lower-role invite never downgrades.
    expect((await editor.api.post(`/invites/${viewerInvite.body.token}/accept`)).body.role).toBe("editor");
  });

  it("lists the trip with members and route summaries", async () => {
    const res = await viewer.api.get<TripDetail>(`/trips/${TRIP}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("viewer");
    expect(res.body.members.map((m) => m.role).sort()).toEqual(["editor", "owner", "viewer"]);
    expect(res.body.routes.map((r) => [r.name, r.totalNights, r.returnDate, r.isCurrent])).toEqual([
      ["Main", 40, "2027-06-19", true],
      ["With Shanghai", 36, "2027-06-15", false],
    ]);
    expect(res.body.routes[0]!.checksLevel).toBe("warn");
  });

  it("stops viewers from editing", async () => {
    const res = await viewer.api.patch(`/routes/${MAIN}`, { name: "Hacked", version: 0 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("gives the demo account read-only access", async () => {
    const demo = await client(h.app).post("/auth/demo");
    const api = client(h.app, demo.body.token);
    expect((await api.get(`/routes/${MAIN}`)).status).toBe(200);
    const vote = await api.put("/activities/act-liziba/vote", { value: 1 });
    expect(vote.status).toBe(403);
    expect(vote.body.error.message).toMatch(/read-only/);
  });
});

describe("route editor", () => {
  it("loads the Main route with computed dates and checks", async () => {
    const res = await owner.api.get<RouteView>(`/routes/${MAIN}`);
    const view = res.body;
    expect(view.stops.map((s) => s.city.code)).toEqual(
      ["TYO", "BJS", "SIA", "CKG", "CAN", "SZX", "HKG", "HAN", "SGN", "KOM", "DPS"],
    );
    expect(view.stops[0]).toMatchObject({ arrive: "2027-05-10", depart: "2027-05-14", arriveMode: "flight" });
    expect(view.checks).toMatchObject({ totalNights: 40, returnDate: "2027-06-19", level: "warn" });
    const china = view.checks.visa.find((v) => v.countryIso === "CN")!;
    expect(china.entries).toEqual([
      expect.objectContaining({ days: 20, arrive: "2027-05-14", depart: "2027-06-02", overLimit: false }),
    ]);
    expect(view.checks.events.find((e) => e.activityId === "act-npb")).toMatchObject({ fits: true });
    expect(view.stops[0]!.planned.map((p) => p.id).sort()).toEqual(["act-npb", "act-sumo"]);
  });

  it("reorders stops, recomputes dates, and bumps the version", async () => {
    const before = (await editor.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const ids = before.stops.map((s) => s.id);
    const ckg = ids[3]!;
    const moved = [ids[0]!, ckg, ...ids.filter((id, i) => i !== 0 && id !== ckg)];
    const res = await editor.api.put<RouteView>(`/routes/${MAIN}/order`, { stopIds: moved, version: before.route.version });
    expect(res.status).toBe(200);
    expect(res.body.route.version).toBe(before.route.version + 1);
    expect(res.body.stops[1]).toMatchObject({ city: { code: "CKG" }, arrive: "2027-05-14", depart: "2027-05-18" });
    // Still one China entry: Chongqing now sits with Beijing and Xi'an.
    expect(res.body.checks.visa[0]!.entries).toHaveLength(1);
  });

  it("returns 409 when two friends edit at once", async () => {
    const current = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const stale = current.route.version - 1;
    const res = await owner.api.put(`/routes/${MAIN}/order`, {
      stopIds: current.stops.map((s) => s.id),
      version: stale,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "version_conflict", details: { currentVersion: current.route.version } });
    const patch = await owner.api.patch(`/stops/${current.stops[0]!.id}`, { nights: 9, version: stale });
    expect(patch.status).toBe(409);
  });

  it("rejects a reorder that drops or duplicates stops", async () => {
    const current = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const ids = current.stops.map((s) => s.id);
    const res = await owner.api.put(`/routes/${MAIN}/order`, { stopIds: [...ids.slice(1), ids[1]], version: current.route.version });
    expect(res.status).toBe(400);
  });

  it("adds, edits and removes a stop", async () => {
    let view = (await editor.api.get<RouteView>(`/routes/${SHANGHAI}`)).body;
    const added = await editor.api.post<RouteView>(`/routes/${SHANGHAI}/stops`, {
      cityCode: "ckg",
      nights: 2,
      position: 3,
      arriveMode: "hsr",
      version: view.route.version,
    });
    expect(added.status).toBe(201);
    view = added.body;
    expect(view.stops[3]).toMatchObject({ city: { code: "CKG" }, nights: 2, arriveMode: "hsr", order: 3 });
    expect(view.checks.totalNights).toBe(38);

    const stopId = view.stops[3]!.id;
    const edited = await editor.api.patch<RouteView>(`/stops/${stopId}`, {
      nights: 3,
      arriveNote: "Overnight train",
      notes: "Try the hotpot",
      version: view.route.version,
    });
    expect(edited.body.stops[3]).toMatchObject({ nights: 3, arriveNote: "Overnight train", notes: "Try the hotpot" });
    expect(edited.body.checks.totalNights).toBe(39);

    const removed = await editor.api.del<RouteView>(`/stops/${stopId}?version=${edited.body.route.version}`);
    expect(removed.status).toBe(200);
    expect(removed.body.stops.map((s) => s.city.code)).not.toContain("CKG");
    expect(removed.body.checks.totalNights).toBe(36);
  });

  it("flags a China entry over 30 days", async () => {
    const view = (await owner.api.get<RouteView>(`/routes/${SHANGHAI}`)).body;
    const beijing = view.stops.find((s) => s.city.code === "BJS")!;
    const res = await owner.api.patch<RouteView>(`/stops/${beijing.id}`, { nights: 18, version: view.route.version });
    const check = res.body.checks.checks.find((c) => c.kind === "visa-days")!;
    expect(check).toMatchObject({ level: "error", title: "China entry 1: 31 of 30 days" });
    // Put it back.
    await owner.api.patch(`/stops/${beijing.id}`, { nights: 8, version: res.body.route.version });
  });
});

describe("tagged routes", () => {
  let copyId: string;

  it("duplicates a route with its stops and plans, plus lineage", async () => {
    const res = await editor.api.post<RouteView>(`/trips/${TRIP}/routes`, { fromRouteId: SHANGHAI, name: "Budget" });
    expect(res.status).toBe(201);
    copyId = res.body.route.id;
    expect(res.body.route).toMatchObject({ name: "Budget", tags: ["older", "cost estimate"], isCurrent: false, version: 0 });
    expect(res.body.route.derivedFrom).toEqual({ id: SHANGHAI, name: "With Shanghai" });
    const source = (await editor.api.get<RouteView>(`/routes/${SHANGHAI}`)).body;
    expect(res.body.stops.map((s) => [s.city.code, s.nights])).toEqual(source.stops.map((s) => [s.city.code, s.nights]));
    expect(res.body.stops.map((s) => s.id)).not.toEqual(source.stops.map((s) => s.id));
    expect(res.body.stops[0]!.planned.map((p) => p.id).sort()).toEqual(["act-npb", "act-sumo"]);
  });

  it("renames, tags and marks a route as current (only one current)", async () => {
    const res = await editor.api.patch<RouteView>(`/routes/${copyId}`, {
      name: "Budget plan",
      tags: ["budget"],
      isCurrent: true,
      version: 0,
    });
    expect(res.body.route).toMatchObject({ name: "Budget plan", tags: ["budget"], isCurrent: true, version: 1 });
    const trip = (await editor.api.get<TripDetail>(`/trips/${TRIP}`)).body;
    expect(trip.routes.filter((r) => r.isCurrent).map((r) => r.id)).toEqual([copyId]);
    await editor.api.patch(`/routes/${MAIN}`, { isCurrent: true, version: (await editor.api.get(`/routes/${MAIN}`)).body.route.version });
  });

  it("creates an empty route", async () => {
    const res = await editor.api.post<RouteView>(`/trips/${TRIP}/routes`, { name: "Scratch" });
    expect(res.body.stops).toEqual([]);
    expect(res.body.checks).toMatchObject({ totalNights: 0, returnDate: "2027-05-10" });
  });

  it("only lets the owner delete a route", async () => {
    expect((await editor.api.del(`/routes/${copyId}`)).status).toBe(403);
    expect((await owner.api.del(`/routes/${copyId}`)).status).toBe(204);
    expect((await owner.api.get(`/routes/${copyId}`)).status).toBe(404);
  });
});

describe("shared activity library", () => {
  let activityId: string;

  it("adds an activity to Chongqing once and shows it in every route through Chongqing", async () => {
    const created = await editor.api.post<LibraryActivity>("/activities", {
      tripId: TRIP,
      cityCode: "CKG",
      title: "Raffles City Crystal skybridge",
      tags: ["tech", "Culture"],
      costCad: 20,
    });
    expect(created.status).toBe(201);
    activityId = created.body.id;
    expect(created.body).toMatchObject({ cityCode: "CKG", tags: ["culture", "tech"], votes: 0, plannedIn: [] });

    // A second route through Chongqing sees the same activity.
    const dup = await editor.api.post<RouteView>(`/trips/${TRIP}/routes`, { fromRouteId: MAIN, name: "Main v2" });
    for (const routeId of [MAIN, dup.body.route.id]) {
      const lib = (await editor.api.get<StopLibrary[]>(`/routes/${routeId}/library`)).body;
      const ckg = lib.find((l) => l.cityCode === "CKG")!;
      expect(ckg.activities.map((a) => a.id)).toContain(activityId);
    }
    // ...and a route that skips Chongqing does not.
    const shanghai = (await editor.api.get<StopLibrary[]>(`/routes/${SHANGHAI}/library`)).body;
    expect(shanghai.flatMap((l) => l.activities.map((a) => a.id))).not.toContain(activityId);
  });

  it("marks an activity planned at a stop", async () => {
    const view = (await editor.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const ckg = view.stops.find((s) => s.city.code === "CKG")!;
    const res = await editor.api.put<RouteView>(`/stops/${ckg.id}/plans/${activityId}`);
    expect(res.body.stops.find((s) => s.id === ckg.id)!.planned.map((p) => p.id)).toContain(activityId);
    const lib = (await editor.api.get<StopLibrary[]>(`/routes/${MAIN}/library`)).body;
    expect(lib.find((l) => l.stopId === ckg.id)!.activities.find((a) => a.id === activityId)!.planned).toBe(true);
    const trip = (await editor.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`)).body;
    expect(trip.find((a) => a.id === activityId)!.plannedIn.map((p) => p.routeId)).toContain(MAIN);

    // Planning it at a stop in another city is refused.
    const tokyo = view.stops.find((s) => s.city.code === "TYO")!;
    expect((await editor.api.put(`/stops/${tokyo.id}/plans/${activityId}`)).status).toBe(400);

    const unplanned = await editor.api.del<RouteView>(`/stops/${ckg.id}/plans/${activityId}`);
    expect(unplanned.body.stops.find((s) => s.id === ckg.id)!.planned.map((p) => p.id)).not.toContain(activityId);
  });

  it("edits an activity everywhere it appears, including clearing a field", async () => {
    const res = await editor.api.patch<LibraryActivity>(`/activities/${activityId}`, {
      title: "Raffles City skybridge",
      when: { weekdays: [6] },
      costCad: null,
    });
    expect(res.body).toMatchObject({ title: "Raffles City skybridge", when: { weekdays: [6] }, costCad: null });
    const city = (await viewer.api.get<LibraryActivity[]>(`/cities/CKG/activities?tripId=${TRIP}`)).body;
    expect(city.find((a) => a.id === activityId)!.title).toBe("Raffles City skybridge");
  });

  it("filters the city library and searches cities", async () => {
    const res = await viewer.api.get<{ code: string; name: string }[]>("/cities?q=chong");
    expect(res.body[0]).toMatchObject({ code: "CKG", name: "Chongqing" });
    const byCode = await viewer.api.get<{ code: string }[]>("/cities?q=hkg");
    expect(byCode.body[0]!.code).toBe("HKG");
    // Stations are not offered as stops.
    const stations = await viewer.api.get<{ code: string }[]>("/cities?q=longyang");
    expect(stations.body).toEqual([]);
  });

  it("collects votes and comments from the group", async () => {
    const up = await viewer.api.put<LibraryActivity>("/activities/act-liziba/vote", { value: 1 });
    expect(up.body).toMatchObject({ votes: 1, myVote: 1 });
    await editor.api.put("/activities/act-liziba/vote", { value: 1 });
    const changed = await viewer.api.put<LibraryActivity>("/activities/act-liziba/vote", { value: -1 });
    expect(changed.body).toMatchObject({ votes: 0, myVote: -1 });
    const cleared = await viewer.api.put<LibraryActivity>("/activities/act-liziba/vote", { value: 0 });
    expect(cleared.body).toMatchObject({ votes: 1, myVote: 0 });

    const comment = await viewer.api.post("/activities/act-liziba/comments", { text: "Must do, it's on the way" });
    expect(comment.status).toBe(201);
    expect(comment.body).toEqual([expect.objectContaining({ text: "Must do, it's on the way", author: { id: viewer.id, name: "Viewer Friend" } })]);
    const lib = (await viewer.api.get<StopLibrary[]>(`/routes/${MAIN}/library`)).body;
    const liziba = lib.flatMap((l) => l.activities).find((a) => a.id === "act-liziba")!;
    expect(liziba).toMatchObject({ votes: 1, commentCount: 1 });
    expect((await stranger.api.put("/activities/act-liziba/vote", { value: 1 })).status).toBe(404);
  });
});

describe("compare", () => {
  it("compares Main and With Shanghai", async () => {
    const res = await viewer.api.get<CompareResult>(`/compare?a=${MAIN}&b=${SHANGHAI}`);
    expect(res.status).toBe(200);
    const c = res.body;
    expect(c.shared.sort()).toEqual(["Bali", "Beijing", "Hanoi", "Ho Chi Minh City", "Komodo", "Tokyo", "Xi'an"]);
    expect(c.onlyA.sort()).toEqual(["Chongqing", "Guangzhou", "Hong Kong", "Shenzhen"]);
    expect(c.onlyB.sort()).toEqual(["Labuan Bajo", "Shanghai"]);
    expect(c.nightsByCountry.find((n) => n.iso === "CN")).toMatchObject({ a: 19, b: 20 });
    expect(c.nightsByCountry.find((n) => n.iso === "HK")).toMatchObject({ a: 3, b: 0 });
    expect(c.activitiesGained.map((a) => a.id).sort()).toEqual(["act-bund", "act-forbidden-city", "act-maglev"]);
    expect(c.activitiesLost.map((a) => a.id)).toContain("act-liziba");
  });
});

describe("pathfinding (stretch)", () => {
  it("finds the fastest way from Chongqing to Hong Kong", async () => {
    const res = await viewer.api.get<PathResult>("/paths?from=CKG&to=HKG&by=minutes");
    expect(res.body.found).toBe(true);
    expect(res.body.cities.map((c) => c.code)).toEqual(["CKG", "CAN", "SZX", "HKG"]);
    expect(res.body.legs.map((l) => l.mode)).toEqual(["flight", "hsr", "train"]);
    expect(res.body.totalMinutes).toBe(183);
  });

  it("finds a rail-only route when one exists", async () => {
    const res = await viewer.api.get<PathResult>("/paths?from=SIA&to=HKG&by=minutes&railOnly=true");
    expect(res.body.found).toBe(true);
    expect(res.body.legs.every((l) => ["hsr", "train", "maglev"].includes(l.mode))).toBe(true);
    expect(res.body.cities.at(-1)!.code).toBe("HKG");
  });

  it("answers that no train exists from Tokyo to Beijing", async () => {
    const res = await viewer.api.get<PathResult>("/paths?from=TYO&to=BJS&railOnly=true");
    expect(res.body).toMatchObject({ found: false, legs: [] });
  });

  it("counts hops", async () => {
    const res = await viewer.api.get<PathResult>("/paths?from=CKG&to=HKG&by=hops");
    expect(res.body.legs).toHaveLength(2);
  });
});

describe("export (stretch)", () => {
  it("exports the itinerary as text and as a calendar file", async () => {
    const txt = await viewer.api.get(`/routes/${SHANGHAI}/export.txt`);
    expect(txt.headers["content-type"]).toContain("text/plain");
    expect(txt.text).toContain("Asia 2027: With Shanghai");
    expect(txt.text).toContain("Shanghai, China (8 nights)");

    const ics = await viewer.api.get(`/routes/${SHANGHAI}/export.ics`);
    expect(ics.headers["content-type"]).toContain("text/calendar");
    expect(ics.text).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics.text).toContain("DTSTART;VALUE=DATE:20270510");
    expect(ics.text).toContain("SUMMARY:NPB: Yokohama DeNA BayStars vs Yomiuri Giants");
    expect(ics.text.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
  });
});

describe("trips", () => {
  it("creates a new trip with the caller as owner and an empty current route", async () => {
    const res = await stranger.api.post("/trips", { name: "Weekend", startDate: "2027-08-01" });
    expect(res.status).toBe(201);
    const trip = (await stranger.api.get<TripDetail>(`/trips/${res.body.id}`)).body;
    expect(trip.role).toBe("owner");
    expect(trip.routes).toEqual([expect.objectContaining({ name: "Main", isCurrent: true, stopCount: 0 })]);
    const mine = (await stranger.api.get<{ id: string }[]>("/trips")).body;
    expect(mine.map((t) => t.id)).toEqual([res.body.id]);
  });

  it("recomputes every date when the trip start moves", async () => {
    await owner.api.patch(`/trips/${TRIP}`, { startDate: "2027-05-17" });
    const view = (await owner.api.get<RouteView>(`/routes/${SHANGHAI}`)).body;
    expect(view.stops[0]!.arrive).toBe("2027-05-17");
    // The NPB game on May 13 no longer fits.
    expect(view.checks.events.find((e) => e.activityId === "act-npb")!.fits).toBe(false);
    await owner.api.patch(`/trips/${TRIP}`, { startDate: "2027-05-10" });
  });
});
