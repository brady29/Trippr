import type { LibraryActivity, PlaceLookupResult, RouteView } from "@trippr/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GeoQuery, GeoResult, Geocoder } from "../src/services/places/geocoder";
import { signIn, startHarness, type Harness } from "./harness";

const TRIP = "asia-2027";
const MAIN = "route-main";

/** Stands in for OpenStreetMap: answers from a table and records what it was asked. */
const answers = new Map<string, GeoResult | null>();
const asked: GeoQuery[] = [];
const fakeGeocoder: Geocoder = {
  name: "fake",
  async search(query) {
    asked.push(query);
    return answers.get(query.text) ?? null;
  },
};

let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;
let viewer: Awaited<ReturnType<typeof signIn>>;

const create = async (title: string, cityCode = "TYO", extra: Record<string, unknown> = {}) =>
  (await owner.api.post<LibraryActivity>("/activities", { tripId: TRIP, cityCode, title, ...extra })).body;

beforeAll(async () => {
  h = await startHarness({
    geocoder: fakeGeocoder,
    resolveShortLink: async (url) =>
      url === "https://maps.app.goo.gl/sky" ? "https://www.google.com/maps/place/Shibuya+Sky/@35.65,139.70,17z/data=!3d35.65848!4d139.70224" : null,
  });
  owner = await signIn(h.app, "Places Owner");
  viewer = await signIn(h.app, "Places Viewer");
  await owner.api.post(`/invites/${h.ownerInvite}/accept`);
  const invite = await owner.api.post(`/trips/${TRIP}/invites`, { role: "viewer" });
  await viewer.api.post(`/invites/${invite.body.token}/accept`);
});

afterAll(async () => {
  await h?.close();
});

describe("places on activities", () => {
  it("stores website, ticket and reservation links and refuses other schemes", async () => {
    const a = await create("teamLab Planets", "TYO", { website: "https://www.teamlab.art/e/planets/", ticketUrl: "https://www.klook.com/activity/1/" });
    expect(a).toMatchObject({ website: "https://www.teamlab.art/e/planets/", ticketUrl: "https://www.klook.com/activity/1/", reserveUrl: null });
    expect(a).toMatchObject({ placeStatus: "unplaced", lat: null, lon: null, countryIso: "JP" });

    const patched = await owner.api.patch<LibraryActivity>(`/activities/${a.id}`, { reserveUrl: "https://tablecheck.com/x", website: null });
    expect(patched.body).toMatchObject({ website: null, ticketUrl: "https://www.klook.com/activity/1/", reserveUrl: "https://tablecheck.com/x" });

    const bad = await owner.api.patch(`/activities/${a.id}`, { website: "javascript:alert(1)" });
    expect(bad.status).toBe(400);
  });

  it("places a pin found near the city and caches the answer", async () => {
    answers.set("Shibuya Sky, Tokyo", { lat: 35.6585, lon: 139.7022, address: "Shibuya Scramble Square, Tokyo", osmId: "way/1" });
    const a = await create("Shibuya Sky");
    const res = await owner.api.post<PlaceLookupResult>(`/activities/${a.id}/lookup`);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("placed");
    expect(res.body.activity).toMatchObject({ lat: 35.6585, lon: 139.7022, address: "Shibuya Scramble Square, Tokyo", placeStatus: "placed" });
    expect(asked.at(-1)).toMatchObject({ text: "Shibuya Sky, Tokyo", countryIso: "JP" });
    expect(asked.at(-1)!.near).toBeDefined();

    // A second activity with the same name is answered from the cache.
    const twin = await create("Shibuya Sky");
    const before = asked.length;
    expect((await owner.api.post<PlaceLookupResult>(`/activities/${twin.id}/lookup`)).body.outcome).toBe("placed");
    expect(asked.length).toBe(before);

    // The trip library and each route's per-stop library carry the pin too.
    const all = (await owner.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`)).body;
    expect(all.find((x) => x.id === a.id)).toMatchObject({ lat: 35.6585, placeStatus: "placed" });
    const tyo = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body.stops.find((s) => s.city.code === "TYO");
    if (tyo) {
      const library = await owner.api.get<{ stops: { stopId: string; activities: LibraryActivity[] }[] } | Record<string, unknown>>(
        `/routes/${MAIN}/library`,
      );
      expect(JSON.stringify(library.body)).toContain('"placeStatus":"placed"');
    }
  });

  it("marks day-trip distances for a person to check and rejects far-away matches", async () => {
    answers.set("Fuji Five Lakes, Tokyo", { lat: 35.36, lon: 138.73, address: "Fujikawaguchiko", osmId: null });
    const fuji = await create("Fuji Five Lakes");
    expect((await owner.api.post<PlaceLookupResult>(`/activities/${fuji.id}/lookup`)).body).toMatchObject({
      outcome: "check",
      activity: { placeStatus: "check" },
    });

    answers.set("Dotonbori, Tokyo", { lat: 34.6687, lon: 135.5013, address: "Osaka", osmId: null });
    const wrong = await create("Dotonbori");
    expect((await owner.api.post<PlaceLookupResult>(`/activities/${wrong.id}/lookup`)).body).toMatchObject({
      outcome: "not_found",
      activity: { placeStatus: "not_found", lat: null },
    });
  });

  it("lets editors place, move and clear pins by hand, and keeps hand-placed pins", async () => {
    const a = await create("Tiny ramen shop");
    const byPoint = await owner.api.patch<LibraryActivity>(`/activities/${a.id}/place`, { lat: 35.69, lon: 139.7 });
    expect(byPoint.body).toMatchObject({ lat: 35.69, lon: 139.7, placeStatus: "manual" });

    const byLink = await owner.api.patch<LibraryActivity>(`/activities/${a.id}/place`, { link: "https://maps.app.goo.gl/sky" });
    expect(byLink.body).toMatchObject({ lat: 35.65848, lon: 139.70224, placeStatus: "manual", mapsUrl: "https://maps.app.goo.gl/sky" });

    // The lookup never overrides a person.
    expect((await owner.api.post<PlaceLookupResult>(`/activities/${a.id}/lookup`)).body.outcome).toBe("skipped");

    const noPoint = await owner.api.patch(`/activities/${a.id}/place`, { link: "https://www.google.com/maps/search/?api=1&query=ramen" });
    expect(noPoint.status).toBe(400);

    const cleared = await owner.api.patch<LibraryActivity>(`/activities/${a.id}/place`, { clear: true });
    expect(cleared.body).toMatchObject({ lat: null, lon: null, placeStatus: "unplaced", mapsUrl: null });
  });

  it("keeps viewers out of placing", async () => {
    const a = await create("Viewer test");
    expect((await viewer.api.post(`/activities/${a.id}/lookup`)).status).toBe(403);
    expect((await viewer.api.patch(`/activities/${a.id}/place`, { lat: 1, lon: 1 })).status).toBe(403);
  });

  it("puts pins on activity nodes in the graph export", async () => {
    const a = await create("Graph pin");
    await owner.api.patch(`/activities/${a.id}/place`, { lat: 35.7, lon: 139.8 });
    const graph = await owner.api.get<{ nodes: { id: string; lat?: number; lon?: number; attrs: Record<string, unknown> }[] }>(
      `/trips/${TRIP}/graph?scope=trip`,
    );
    const node = graph.body.nodes.find((n) => n.id.endsWith(a.id));
    expect(node).toMatchObject({ lat: 35.7, lon: 139.8, attrs: { placeStatus: "manual" } });
  });
});
