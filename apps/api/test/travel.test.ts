import type { TravelOptionsResult } from "@trippr/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, signIn, startHarness, type Harness } from "./harness";

let h: Harness;
let api: Awaited<ReturnType<typeof signIn>>["api"];

beforeAll(async () => {
  h = await startHarness();
  api = (await signIn(h.app, "Route Planner")).api;
});

afterAll(async () => {
  await h?.close();
});

describe("GET /travel-options", () => {
  it("ranks stored links and estimates between Chongqing and Guangzhou", async () => {
    const res = await api.get<TravelOptionsResult>("/travel-options?from=CKG&to=CAN&travellers=6");
    expect(res.status).toBe(200);
    expect(res.body.distanceKm).toBeGreaterThan(900);
    const modes = res.body.options.map((o) => o.mode);
    expect(modes).toEqual(expect.arrayContaining(["flight", "hsr"]));
    // The stored high-speed link (345 min, $90) plus about 50 min to get to and board the train.
    expect(res.body.options.find((o) => o.mode === "hsr")).toMatchObject({ source: "stored", costPerPersonCad: 90, minutes: 395 });
    expect(res.body.options.filter((o) => o.recommended)).toHaveLength(1);
  });

  it("only offers flights between Tokyo and Beijing", async () => {
    const res = await api.get<TravelOptionsResult>("/travel-options?from=TYO&to=BJS");
    expect(res.body.options.map((o) => o.mode)).toEqual(["flight"]);
  });

  it("changes the recommendation with the priority", async () => {
    const fastest = (await api.get<TravelOptionsResult>("/travel-options?from=CKG&to=CAN&priority=fastest")).body.options[0]!;
    const cheapest = (await api.get<TravelOptionsResult>("/travel-options?from=CKG&to=CAN&priority=cheapest")).body.options[0]!;
    expect(fastest.minutes).toBeLessThanOrEqual(cheapest.minutes);
    expect(cheapest.costPerPersonCad).toBeLessThanOrEqual(fastest.costPerPersonCad);
  });

  it("validates input and requires sign-in", async () => {
    expect((await api.get("/travel-options?from=CKG&to=CKG")).status).toBe(400);
    expect((await api.get("/travel-options?from=CKG&to=ZZZ")).status).toBe(404);
    expect((await client(h.app).get("/travel-options?from=CKG&to=CAN")).status).toBe(401);
  });
});
