import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createDemoProvider } from "../src/services/flights/demo";
import { ProviderAuthError, RateLimitedError } from "../src/services/flights/provider";
import { resolveProvider } from "../src/services/flights/service";
import { createTravelpayouts } from "../src/services/flights/travelpayouts";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

function adapter(respond: (url: URL, init: RequestInit) => Response | Promise<Response>, minIntervalMs = 0) {
  const seen: { url: URL; headers: Record<string, string> }[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const provider = createTravelpayouts({
    token: "unit-test-token",
    minIntervalMs,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    fetch: (async (input: URL, init: RequestInit) => {
      seen.push({ url: new URL(String(input)), headers: init.headers as Record<string, string> });
      return respond(new URL(String(input)), init);
    }) as unknown as typeof fetch,
  });
  return { provider, seen, sleeps, tick: (ms: number) => (clock += ms) };
}

const query = { origin: "YYZ", destination: "NRT", date: "2027-05-12", asOf: "2027-03-01" };

describe("Travelpayouts adapter", () => {
  it("asks for one-way prices in CAD for one date, with the token in a header", async () => {
    const { provider, seen } = adapter(() => json({ success: true, currency: "cad", data: [] }));
    await provider.quote(query);
    const { url, headers } = seen[0]!;
    expect(url.origin + url.pathname).toBe("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      origin: "YYZ",
      destination: "NRT",
      departure_at: "2027-05-12",
      one_way: "true",
      currency: "cad",
      sorting: "price",
    });
    expect(headers["X-Access-Token"]).toBe("unit-test-token");
    // The token never goes in the URL.
    expect(url.search).not.toContain("unit-test-token");
  });

  it("returns the cheapest offer on that day, with airline and stops", async () => {
    const { provider } = adapter(() =>
      json({
        success: true,
        currency: "cad",
        data: [
          { price: 1210.4, airline: "AC", transfers: 1, departure_at: "2027-05-12T09:00:00-04:00" },
          { price: 998.555, airline: "NH", transfers: 0, departure_at: "2027-05-12T13:00:00-04:00" },
          { price: 700, airline: "ZZ", transfers: 0, departure_at: "2027-05-13T13:00:00-04:00" },
          { price: "0", airline: "BAD" },
          { airline: "NOPRICE" },
        ],
      }),
    );
    expect(await provider.quote(query)).toEqual({ priceCad: 998.56, airline: "NH", stops: 0 });
  });

  it("tolerates missing airline and stop fields", async () => {
    const { provider } = adapter(() => json({ success: true, data: [{ price: 500 }] }));
    expect(await provider.quote(query)).toEqual({ priceCad: 500, airline: null, stops: null });
  });

  it("returns null when there is no price", async () => {
    expect(await adapter(() => json({ success: true, data: [] })).provider.quote(query)).toBeNull();
    expect(await adapter(() => json({ success: false, error: "x" })).provider.quote(query)).toBeNull();
    expect(await adapter(() => json({ success: true })).provider.quote(query)).toBeNull();
  });

  it("refuses an answer in another currency rather than showing it as CAD", async () => {
    const { provider } = adapter(() => json({ success: true, currency: "rub", data: [{ price: 5 }] }));
    await expect(provider.quote(query)).rejects.toThrow(/not CAD/);
  });

  it("raises a rate-limit error on 429 and an auth error on 401 or 403", async () => {
    const limited = adapter(() => new Response("", { status: 429, headers: { "retry-after": "30" } }));
    await expect(limited.provider.quote(query)).rejects.toMatchObject({ name: "RateLimitedError", retryAfterSec: 30 });
    await expect(limited.provider.quote(query)).rejects.toBeInstanceOf(RateLimitedError);
    await expect(adapter(() => new Response("", { status: 401 })).provider.quote(query)).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(adapter(() => new Response("", { status: 403 })).provider.quote(query)).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(adapter(() => new Response("", { status: 500 })).provider.quote(query)).rejects.toThrow(/HTTP 500/);
  });

  it("keeps a minimum gap between requests", async () => {
    const { provider, sleeps, tick } = adapter(() => json({ success: true, data: [] }), 250);
    await provider.quote(query);
    await provider.quote(query);
    tick(1000);
    await provider.quote(query);
    // The first needs no wait; the second waits out the gap; the third comes late enough.
    expect(sleeps).toEqual([250]);
  });
});

describe("demo provider", () => {
  const demo = createDemoProvider();

  it("is labelled as sample data", () => {
    expect(demo).toMatchObject({ id: "demo", sample: true });
  });

  it("gives the same answer for the same question", async () => {
    expect(await demo.quote(query)).toEqual(await createDemoProvider().quote(query));
  });

  it("gives different prices on different days, and prices that look like fares", async () => {
    const prices = new Set<number>();
    for (let d = 1; d <= 20; d++) {
      const q = await demo.quote({ ...query, asOf: `2027-03-${String(d).padStart(2, "0")}` });
      if (q) {
        prices.add(q.priceCad);
        expect(q.priceCad).toBeGreaterThan(150);
        expect(q.priceCad).toBeLessThan(4000);
        expect(Number.isInteger(q.priceCad)).toBe(true);
      }
    }
    expect(prices.size).toBeGreaterThan(5);
  });

  it("dips on the chosen day for some routes only", async () => {
    const dip = createDemoProvider({ dipDay: "2027-03-01" });
    let dipped = 0;
    let same = 0;
    for (const [origin, destination] of [["YYZ", "HND"], ["HND", "PEK"], ["HKG", "HAN"], ["HAN", "SGN"], ["LBJ", "DPS"]] as const) {
      const q = { origin, destination, date: "2027-05-15", asOf: "2027-03-01" };
      const [a, b] = [await dip.quote(q), await demo.quote(q)];
      if (a && b && a.priceCad < b.priceCad * 0.8) dipped++;
      else if (a && b && a.priceCad === b.priceCad) same++;
    }
    expect(dipped).toBeGreaterThan(0);
    expect(same).toBeGreaterThan(0);
  });
});

describe("provider selection", () => {
  const base = { NODE_ENV: "test", APP_JWT_SECRET: "unit-test-secret-unit-test-secret-1234" };
  it("uses no provider without a key", () => {
    expect(resolveProvider(loadConfig({ ...base }))).toBeNull();
    expect(resolveProvider(loadConfig({ ...base, FLIGHT_PRICES_PROVIDER: "travelpayouts", TRAVELPAYOUTS_TOKEN: "" }))).toBeNull();
  });
  it("uses Travelpayouts only when its token is set", () => {
    expect(resolveProvider(loadConfig({ ...base, TRAVELPAYOUTS_TOKEN: "x" }))?.id).toBe("travelpayouts");
  });
  it("uses the demo provider in demo mode", () => {
    expect(resolveProvider(loadConfig({ ...base, FLIGHT_PRICES_PROVIDER: "demo" }))).toMatchObject({ id: "demo", sample: true });
  });
  it("is off by default, with a 300-request budget and a 3-day window", () => {
    expect(loadConfig({ ...base })).toMatchObject({
      FLIGHT_PRICES_ENABLED: false,
      FLIGHT_PRICES_DAILY_BUDGET: 300,
      FLIGHT_PRICES_WINDOW_DAYS: 3,
      FLIGHT_PRICES_DROP_PCT: 15,
    });
  });
});
