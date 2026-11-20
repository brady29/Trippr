import type { RouteView } from "@trippr/contracts";
import { buildItinerary } from "@trippr/rules";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signIn, startHarness, type Harness } from "./harness";

const TRIP = "asia-2027";
const MAIN = "route-main";

let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;
let viewer: Awaited<ReturnType<typeof signIn>>;
let tokyo: RouteView["stops"][number];
let activityId: string;

beforeAll(async () => {
  h = await startHarness();
  owner = await signIn(h.app, "Itinerary Owner");
  viewer = await signIn(h.app, "Itinerary Viewer");
  await owner.api.post(`/invites/${h.ownerInvite}/accept`);
  const invite = await owner.api.post(`/trips/${TRIP}/invites`, { role: "viewer" });
  await viewer.api.post(`/invites/${invite.body.token}/accept`);
  const view = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
  tokyo = view.stops.find((s) => s.city.code === "TYO")!;
  activityId = (await owner.api.post<{ id: string }>("/activities", { tripId: TRIP, cityCode: "TYO", title: "Shibuya Sky at sunset" })).body.id;
});

afterAll(async () => {
  await h?.close();
});

const planned = (view: RouteView) => view.stops.find((s) => s.id === tokyo.id)!.planned.find((p) => p.id === activityId);

describe("itinerary", () => {
  it("gives every stop's city a time zone, with per-city overrides", async () => {
    const view = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
    expect(view.stops.find((s) => s.city.code === "TYO")!.city.tz).toBe("Asia/Tokyo");
    const china = view.stops.find((s) => s.country.iso === "CN");
    if (china) expect(china.city.tz).toBe("Asia/Shanghai");
    for (const s of view.stops) expect(s.city.tz).toMatch(/^[A-Z][A-Za-z_]+\/[A-Za-z_]+$/);
  });

  it("plans an activity onto a day with a start time and length", async () => {
    const res = await owner.api.put<RouteView>(`/stops/${tokyo.id}/plans/${activityId}`, { day: 2, startTime: "18:30", durationMin: 90 });
    expect(res.status).toBe(200);
    expect(planned(res.body)).toMatchObject({ day: 2, startTime: "18:30", durationMin: 90 });

    const days = buildItinerary(res.body.stops);
    const target = days.days.find((d) => d.stopId === tokyo.id && d.stopDay === 2)!;
    expect(target.items.map((i) => i.activityId)).toContain(activityId);
  });

  it("leaves fields the request doesn't mention alone, and clears ones set to null", async () => {
    const moved = await owner.api.put<RouteView>(`/stops/${tokyo.id}/plans/${activityId}`, { day: 3 });
    expect(planned(moved.body)).toMatchObject({ day: 3, startTime: "18:30", durationMin: 90 });
    const cleared = await owner.api.put<RouteView>(`/stops/${tokyo.id}/plans/${activityId}`, { startTime: null });
    expect(planned(cleared.body)).toMatchObject({ day: 3, startTime: null, durationMin: 90 });
  });

  it("refuses times that aren't 24-hour HH:MM and keeps viewers out", async () => {
    expect((await owner.api.put(`/stops/${tokyo.id}/plans/${activityId}`, { startTime: "6pm" })).status).toBe(400);
    expect((await owner.api.put(`/stops/${tokyo.id}/plans/${activityId}`, { durationMin: 5 })).status).toBe(400);
    expect((await viewer.api.put(`/stops/${tokyo.id}/plans/${activityId}`, { day: 1 })).status).toBe(403);
  });

  it("copies days and times when a route is duplicated", async () => {
    await owner.api.put(`/stops/${tokyo.id}/plans/${activityId}`, { day: 1, startTime: "09:15", durationMin: 60 });
    const copy = await owner.api.post<RouteView>(`/trips/${TRIP}/routes`, { fromRouteId: MAIN, name: "Itinerary copy" });
    expect(copy.status).toBe(201);
    const copied = copy.body.stops.find((s) => s.city.code === "TYO")!.planned.find((p) => p.id === activityId);
    expect(copied).toMatchObject({ day: 1, startTime: "09:15", durationMin: 60 });
  });
});
