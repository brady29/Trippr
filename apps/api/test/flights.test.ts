import type { FlightPriceHistory, RouteView, TripFlightPrices } from "@trippr/contracts";
import { addDays, daysBetween } from "@trippr/rules";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepositories } from "../src/repositories";
import { createDemoProvider } from "../src/services/flights/demo";
import { collectHops, runSnapshotJob, seedDemoHistory } from "../src/services/flights/job";
import { ProviderAuthError, RateLimitedError, type FlightPriceProvider, type FlightQuery } from "../src/services/flights/provider";
import { createFlightPrices, flightHops, type FlightHop } from "../src/services/flights/service";
import { client, signIn, startHarness, type Harness } from "./harness";

const TRIP = "asia-2027";
const MAIN = "route-main";
const FLIGHT_ENV = {
  FLIGHT_PRICES_ENABLED: "true",
  FLIGHT_PRICES_PROVIDER: "travelpayouts",
  // A placeholder: the tests inject a fake provider and nothing ever calls the real API.
  TRAVELPAYOUTS_TOKEN: "test-token-not-a-real-key",
};

/** A scripted provider: the price depends on the route's day count since `start`. */
function scripted(price: (q: FlightQuery) => number | null) {
  const calls: FlightQuery[] = [];
  let hook: ((n: number) => void) | null = null;
  const provider: FlightPriceProvider = {
    id: "fixture",
    sample: false,
    async quote(q) {
      calls.push(q);
      hook?.(calls.length);
      const p = price(q);
      return p == null ? null : { priceCad: p, airline: "XX", stops: 0 };
    },
  };
  return {
    provider,
    calls,
    /** Called with the running call count before each quote; throw to simulate a failure. */
    onCall: (fn: ((n: number) => void) | null) => (hook = fn),
    reset: () => (calls.length = 0),
  };
}

const flightsOf = (view: RouteView) => flightHops(view);

describe("flight prices: off by default", () => {
  let h: Harness;
  let api: Awaited<ReturnType<typeof signIn>>["api"];
  beforeAll(async () => {
    h = await startHarness();
    const owner = await signIn(h.app, "Flights Off Owner");
    await owner.api.post(`/invites/${h.ownerInvite}/accept`);
    api = owner.api;
  });
  afterAll(async () => {
    await h?.close();
  });

  it("answers 'off' without a provider or the setting, and the job does nothing", async () => {
    const view = (await api.get<RouteView>(`/routes/${MAIN}`)).body;
    const leg = flightsOf(view)[0]!;
    const res = await api.get<FlightPriceHistory>(`/legs/${leg.legId}/flight-prices`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "off", points: [], latest: null, signal: null });
    expect(res.body.disclaimer).toMatch(/estimates/);
    const trip = await api.get<TripFlightPrices>(`/trips/${TRIP}/flight-prices`);
    expect(trip.body).toMatchObject({ enabled: false, items: [], notices: [] });

    const fake = scripted(() => 500);
    const flights = createFlightPrices({ config: h.config, repos: createRepositories(h.db), provider: fake.provider });
    const result = await runSnapshotJob({ config: h.config, db: h.db, flights, today: "2027-03-01" });
    expect(result.status).toBe("disabled");
    expect(fake.calls).toHaveLength(0);
  });

  it("is not configured, and does nothing, when it is on but there is no key", async () => {
    const config = { ...h.config, FLIGHT_PRICES_ENABLED: true, FLIGHT_PRICES_PROVIDER: "travelpayouts" as const, TRAVELPAYOUTS_TOKEN: undefined };
    const flights = createFlightPrices({ config, repos: createRepositories(h.db) });
    expect(flights.provider).toBeNull();
    const result = await runSnapshotJob({ config, db: h.db, flights, today: "2027-03-01" });
    expect(result.status).toBe("not_configured");
    const rows = await h.db.query<{ n: number }>("MATCH (p:FlightPrice) RETURN count(p) AS n");
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });
});

describe("flight prices: snapshots, history, signal and notices", () => {
  let h: Harness;
  let owner: Awaited<ReturnType<typeof signIn>>;
  let viewer: Awaited<ReturnType<typeof signIn>>;
  let stranger: Awaited<ReturnType<typeof signIn>>;
  let hops: FlightHop[];
  let day0: string;
  const clock = { today: "" };
  const day = (n: number) => addDays(day0, n);
  const fake = scripted((q) => {
    // Flat at 1000 for 8 days, then a 30% dip on day 8, then back up. Days before the planned date cost
    // 20 less per day and days after it 20 more, so the planned date is the middle of the window.
    const n = daysBetween(day0, q.asOf);
    const base = n === 8 ? 700 : 1000;
    const hop = hops.find((x) => x.origin === q.origin && x.destination === q.destination && Math.abs(daysBetween(x.departDate, q.date)) <= 3);
    return base + 20 * (hop ? daysBetween(hop.departDate, q.date) : 0);
  });

  const config = () => ({ ...h.config });
  const flightsFor = (cfg = config()) =>
    createFlightPrices({ config: cfg, repos: createRepositories(h.db), provider: fake.provider, today: () => clock.today });
  const run = (cfg = config(), extra: { force?: boolean; dryRun?: boolean } = {}) =>
    runSnapshotJob({ config: cfg, db: h.db, flights: flightsFor(cfg), today: clock.today, ...extra });
  const history = async (legId: string) => (await owner.api.get<FlightPriceHistory>(`/legs/${legId}/flight-prices`)).body;
  const count = async (cypher: string) => Number(((await h.db.query<{ n: number }>(cypher))[0] ?? { n: 0 }).n);

  beforeAll(async () => {
    // Placeholder clock; replaced once the route's dates are known.
    h = await startHarness({
      env: FLIGHT_ENV,
      flightPrices: { provider: fake.provider, today: () => clock.today },
    });
    owner = await signIn(h.app, "Flights Owner");
    viewer = await signIn(h.app, "Flights Viewer");
    stranger = await signIn(h.app, "Flights Stranger");
    await owner.api.post(`/invites/${h.ownerInvite}/accept`);
    const invite = await owner.api.post(`/trips/${TRIP}/invites`, { role: "viewer" });
    await viewer.api.post(`/invites/${invite.body.token}/accept`);
    const view = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
    hops = flightsOf(view);
    // Start 80 days before the first flight so every flight is inside the window the job looks at.
    day0 = addDays(hops.map((x) => x.departDate).sort()[0]!, -80);
    clock.today = day0;
  });

  afterAll(async () => {
    await h?.close();
  });

  it("finds the route's flights between airports, with a date for each", () => {
    expect(hops.length).toBeGreaterThanOrEqual(3);
    for (const hop of hops) {
      expect(hop.origin).toMatch(/^[A-Z]{3}$/);
      expect(hop.destination).toMatch(/^[A-Z]{3}$/);
      expect(hop.departDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(hops[0]).toMatchObject({ origin: "YYZ", destination: "HND", travellers: 6 });
  });

  it("plans a run without calling the provider or writing (dry run)", async () => {
    const result = await run(config(), { dryRun: true });
    expect(result).toMatchObject({ status: "done", written: 0, requests: 0, planned: hops.length * 7 });
    expect(fake.calls).toHaveLength(0);
    expect(await count("MATCH (p:FlightPrice) RETURN count(p) AS n")).toBe(0);
  });

  it("keeps a price a person typed, and fills in flights still at 'idea' (day 0)", async () => {
    const view = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const typed = hops[1]!;
    const res = await owner.api.patch<RouteView>(`/legs/${typed.legId}`, { priceCad: 1234, version: view.route.version });
    expect(res.status).toBe(200);

    const first = await run();
    expect(first).toMatchObject({ status: "done", flights: hops.length, written: hops.length, skipped: 0, requests: hops.length * 7 });
    expect(await count("MATCH (p:FlightPrice) RETURN count(p) AS n")).toBe(hops.length);

    const after = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const leg = (id: string) => after.stops.flatMap((s) => s.legs).find((l) => l.id === id)!;
    expect(leg(hops[0]!.legId)).toMatchObject({ priceCad: 1000, priceSource: "fixture", priceAsOf: day0 });
    expect(leg(typed.legId)).toMatchObject({ priceCad: 1234, priceSource: null });
    expect(first.legsUpdated).toBe(hops.length - 1);
  });

  it("stops updating a flight's price once a person changes it", async () => {
    const view = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const target = hops[0]!;
    // Saving the same price again keeps it as the snapshot's...
    let res = await owner.api.patch<RouteView>(`/legs/${target.legId}`, { priceCad: 1000, version: view.route.version });
    const leg = (v: RouteView) => v.stops.flatMap((s) => s.legs).find((l) => l.id === target.legId)!;
    expect(leg(res.body).priceSource).toBe("fixture");
    // ...changing it makes it theirs.
    res = await owner.api.patch<RouteView>(`/legs/${target.legId}`, { priceCad: 950, version: res.body.route.version });
    expect(leg(res.body)).toMatchObject({ priceCad: 950, priceSource: null });
  });

  it("is idempotent per route and day: a second run asks the provider for nothing", async () => {
    fake.reset();
    const again = await run();
    expect(again).toMatchObject({ status: "done", written: 0, skipped: hops.length, requests: 0 });
    expect(fake.calls).toHaveLength(0);
    expect(await count("MATCH (p:FlightPrice) RETURN count(p) AS n")).toBe(hops.length);
    expect(await count("MATCH (r:FlightPriceRun) RETURN r.requests AS n")).toBe(hops.length * 7);
  });

  it("serves the first snapshot with a window of nearby dates and says it is too early to advise", async () => {
    const res = await history(hops[0]!.legId);
    expect(res).toMatchObject({
      status: "ok",
      provider: "fixture",
      sample: false,
      origin: "YYZ",
      destination: "HND",
      departDate: hops[0]!.departDate,
      travellers: 6,
    });
    expect(res.points).toEqual([{ snapshotDate: day0, priceCad: 1000, airline: "XX", stops: 0 }]);
    expect(res.latest!.window).toHaveLength(7);
    expect(res.latest!.window.map((w) => w.date)).toEqual([-3, -2, -1, 0, 1, 2, 3].map((d) => addDays(hops[0]!.departDate, d)));
    expect(res.latest!.cheapest).toEqual({ date: addDays(hops[0]!.departDate, -3), priceCad: 940, savingCad: 60, isPlanned: false });
    expect(res.signal).toMatchObject({ verdict: "watch", confidence: "low", samples: 1 });
    expect(res.disclaimer).toMatch(/estimates/i);
    expect(res.drop).toBeNull();
  });

  it("builds up history day by day and then notices a dip of 15% or more (days 1 to 8)", async () => {
    for (let n = 1; n <= 8; n++) {
      clock.today = day(n);
      const r = await run();
      expect(r).toMatchObject({ status: "done", written: hops.length });
    }
    const res = await history(hops[0]!.legId);
    expect(res.points).toHaveLength(9);
    expect(res.points.at(-1)).toMatchObject({ snapshotDate: day(8), priceCad: 700 });
    expect(res.signal).toMatchObject({ verdict: "buy", lowestCad: 700, highestCad: 1000, lowerThanPct: 100, samples: 9 });
    expect(res.signal!.reason).toMatch(/Lower than 100%/);
    expect(res.drop).toMatchObject({ pct: 30, previousLowCad: 1000, priceCad: 700, snapshotDate: day(8) });

    const trip = (await owner.api.get<TripFlightPrices>(`/trips/${TRIP}/flight-prices`)).body;
    expect(trip).toMatchObject({ enabled: true, sample: false, provider: "fixture" });
    expect(trip.items).toHaveLength(hops.length);
    expect(trip.notices).toHaveLength(hops.length);
    expect(trip.items[0]).toMatchObject({ latestCad: 700, asOf: day(8), verdict: "buy" });
    expect(trip.notices[0]!.drop).toMatchObject({ pct: 30 });
  });

  it("drops the notice after a week but keeps the history", async () => {
    clock.today = day(9);
    expect((await owner.api.get<TripFlightPrices>(`/trips/${TRIP}/flight-prices`)).body.notices).toHaveLength(hops.length);
    clock.today = day(16);
    const trip = (await owner.api.get<TripFlightPrices>(`/trips/${TRIP}/flight-prices`)).body;
    expect(trip.notices).toEqual([]);
    expect(trip.items).toHaveLength(hops.length);
    expect((await history(hops[0]!.legId)).points).toHaveLength(9);
  });

  it("respects the per-day request budget, and finishes the rest when the budget allows", async () => {
    clock.today = day(20);
    const tight = { ...config(), FLIGHT_PRICES_DAILY_BUDGET: 10 };
    const first = await run(tight);
    expect(first).toMatchObject({ status: "budget_exhausted", written: 1, requests: 7 });
    // The count is kept across runs on the same day: only 3 requests are left, a flight needs 7.
    fake.reset();
    const second = await run(tight);
    expect(second).toMatchObject({ status: "budget_exhausted", written: 0, skipped: 1, requests: 0 });
    expect(fake.calls).toHaveLength(0);
    // With the normal budget the remaining flights go through, without repeating the first.
    const third = await run();
    expect(third).toMatchObject({ status: "done", written: hops.length - 1, skipped: 1, requests: (hops.length - 1) * 7 });
    const runs = await h.db.query<{ requests: number }>("MATCH (r:FlightPriceRun {id: $id}) RETURN r.requests AS requests", { id: `fixture:${day(20)}` });
    expect(Number(runs[0]!.requests)).toBe(hops.length * 7);
  });

  it("stops at the provider's rate limit and leaves no half-finished snapshot", async () => {
    clock.today = day(21);
    fake.reset();
    fake.onCall((n) => {
      if (n === 10) throw new RateLimitedError("slow down", 60);
    });
    const r = await run();
    fake.onCall(null);
    expect(r).toMatchObject({ status: "rate_limited", written: 1, requests: 10 });
    expect((await history(hops[0]!.legId)).points.at(-1)).toMatchObject({ snapshotDate: day(21) });
    expect((await history(hops[1]!.legId)).points.at(-1)).toMatchObject({ snapshotDate: day(20) });
    // The next run picks up where it stopped.
    const next = await run();
    expect(next).toMatchObject({ status: "done", written: hops.length - 1, skipped: 1 });
  });

  it("stops on an auth error, and carries on past a single failing flight", async () => {
    clock.today = day(22);
    fake.onCall((n) => {
      if (n === 1) throw new ProviderAuthError("bad token");
    });
    expect(await run()).toMatchObject({ status: "auth_failed", written: 0 });
    fake.onCall(null);

    clock.today = day(23);
    fake.reset();
    fake.onCall((n) => {
      if (n === 2) throw new Error("timeout");
    });
    const r = await run();
    fake.onCall(null);
    expect(r.status).toBe("done");
    expect(r.written).toBe(hops.length - 1);
    // Tried again the next day... and the same day, since nothing was stored for it.
    clock.today = day(23);
    expect((await run()).written).toBe(1);
  });

  it("stores a snapshot without a price when the provider has none, and does not ask again that day", async () => {
    clock.today = day(24);
    const none = scripted(() => null);
    const cfg = config();
    const flights = createFlightPrices({ config: cfg, repos: createRepositories(h.db), provider: none.provider, today: () => clock.today });
    const r = await runSnapshotJob({ config: cfg, db: h.db, flights, today: clock.today });
    expect(r).toMatchObject({ written: hops.length, noPrice: hops.length });
    const again = await runSnapshotJob({ config: cfg, db: h.db, flights, today: clock.today });
    expect(again).toMatchObject({ written: 0, skipped: hops.length, requests: 0 });
    const res = await history(hops[0]!.legId);
    expect(res.latest).toMatchObject({ snapshotDate: day(24), priceCad: null });
    expect(res.signal).toBeNull();
    expect(res.points.every((p) => p.snapshotDate !== day(24))).toBe(true);
  });

  it("lets viewers read prices, and keeps strangers and signed-out callers out", async () => {
    clock.today = day(9);
    const leg = hops[0]!.legId;
    const asViewer = await viewer.api.get<FlightPriceHistory>(`/legs/${leg}/flight-prices`);
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.points.length).toBeGreaterThan(5);
    expect((await viewer.api.get(`/trips/${TRIP}/flight-prices`)).status).toBe(200);

    expect((await stranger.api.get(`/legs/${leg}/flight-prices`)).status).toBe(404);
    expect((await stranger.api.get(`/trips/${TRIP}/flight-prices`)).status).toBe(404);
    expect((await client(h.app).get(`/legs/${leg}/flight-prices`)).status).toBe(401);
    expect((await client(h.app).get(`/trips/${TRIP}/flight-prices`)).status).toBe(401);
    expect((await owner.api.get(`/legs/nope/flight-prices`)).status).toBe(404);

    const demo = client(h.app, (await client(h.app).post("/auth/demo")).body.token);
    expect((await demo.get(`/legs/${leg}/flight-prices`)).status).toBe(200);
    expect((await demo.get(`/trips/${TRIP}/flight-prices`)).status).toBe(200);
  });

  it("says 'not a flight' for a train leg", async () => {
    const view = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const train = view.stops.flatMap((s) => s.legs).find((l) => l.mode === "hsr")!;
    const res = await owner.api.get<FlightPriceHistory>(`/legs/${train.id}/flight-prices`);
    expect(res.body).toMatchObject({ status: "not_flight", points: [], signal: null });
  });

  it("keeps the history of a flight that has left, with no advice", async () => {
    clock.today = addDays(hops[0]!.departDate, 2);
    const res = await history(hops[0]!.legId);
    expect(res.status).toBe("past");
    expect(res.signal).toBeNull();
    expect(res.points.length).toBeGreaterThan(5);
    const trip = (await owner.api.get<TripFlightPrices>(`/trips/${TRIP}/flight-prices`)).body;
    expect(trip.items.find((i) => i.legId === hops[0]!.legId)).toBeUndefined();
  });

  it("collects each flight once, nearest first, only from current routes", async () => {
    const found = await collectHops(createRepositories(h.db), day0);
    expect(found.map((f) => f.hop.departDate)).toEqual([...found.map((f) => f.hop.departDate)].sort());
    expect(new Set(found.map((f) => `${f.hop.origin}-${f.hop.destination}-${f.hop.departDate}`)).size).toBe(found.length);
  });
});

describe("flight prices: demo mode", () => {
  let h: Harness;
  let owner: Awaited<ReturnType<typeof signIn>>;
  const clock = { today: "" };
  beforeAll(async () => {
    h = await startHarness({ env: { FLIGHT_PRICES_ENABLED: "true", FLIGHT_PRICES_PROVIDER: "demo" }, flightPrices: { today: () => clock.today } });
    owner = await signIn(h.app, "Flights Demo Owner");
    await owner.api.post(`/invites/${h.ownerInvite}/accept`);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("seeds labelled sample history, with a price-drop notice, and never touches a leg's price", async () => {
    const view = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const hops = flightsOf(view);
    const today = addDays(hops.map((x) => x.departDate).sort()[0]!, -60);
    clock.today = today;
    const flights = createFlightPrices({
      config: h.config,
      repos: createRepositories(h.db),
      provider: createDemoProvider({ dipDay: today }),
      today: () => today,
    });
    const seeded = await seedDemoHistory({ config: h.config, db: h.db, flights, today, days: 30 });
    expect(seeded.flights).toBe(hops.length);
    expect(seeded.snapshots).toBe(hops.length * 31);

    const res = (await owner.api.get<FlightPriceHistory>(`/legs/${hops[0]!.legId}/flight-prices`)).body;
    expect(res).toMatchObject({ status: "ok", provider: "demo", sample: true });
    // A day or two can have no price (the demo provider leaves gaps, like real data).
    expect(res.points.length).toBeGreaterThanOrEqual(25);
    expect(res.points.length).toBeLessThanOrEqual(31);
    expect(res.signal).not.toBeNull();
    const trip = (await owner.api.get<TripFlightPrices>(`/trips/${TRIP}/flight-prices`)).body;
    expect(trip.sample).toBe(true);
    expect(trip.notices.length).toBeGreaterThan(0);
    expect(trip.notices.length).toBeLessThan(hops.length);

    const after = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
    expect(after.stops.flatMap((s) => s.legs).every((l) => l.priceSource == null)).toBe(true);
  });

  it("will not write sample history for a real provider", async () => {
    const real = scripted(() => 1);
    const flights = createFlightPrices({ config: h.config, repos: createRepositories(h.db), provider: real.provider });
    await expect(seedDemoHistory({ config: h.config, db: h.db, flights, today: "2027-01-01" })).rejects.toThrow(/demo/);
  });
});
