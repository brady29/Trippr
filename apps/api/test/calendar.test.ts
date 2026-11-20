import type { CalendarFeedLink, CalendarFeedStatus, RouteView } from "@trippr/contracts";
import { addDays, localInstant } from "@trippr/rules";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { icsUtc } from "../src/services/export";
import { client, signIn, startHarness, type Harness } from "./harness";

const TRIP = "asia-2027";
const MAIN = "route-main";
const SECRET_REF = "CALREF-7731";
const FEED_URL = /^http:\/\/localhost(:\d+)?\/cal\/[A-Za-z0-9_-]{43}\.ics$/;

let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;
let editor: Awaited<ReturnType<typeof signIn>>;
let viewer: Awaited<ReturnType<typeof signIn>>;
let leaver: Awaited<ReturnType<typeof signIn>>;
let anon: ReturnType<typeof client>;
let tokyo: RouteView["stops"][number];
let legId = "";
let activityId = "";

/** The feed's path, from the link the API returned. */
const pathOf = (link: CalendarFeedLink) => new URL(link.url).pathname;
/** Fetch a feed with no Authorization header, as a calendar app would. */
const fetchFeed = (path: string) => anon.get(path);
/** Undo RFC 5545 line folding. */
const unfold = (ics: string) => ics.replace(/\r\n /g, "");

async function invite(role: "editor" | "viewer", who: Awaited<ReturnType<typeof signIn>>) {
  const res = await owner.api.post(`/trips/${TRIP}/invites`, { role });
  await who.api.post(`/invites/${res.body.token}/accept`);
}

beforeAll(async () => {
  h = await startHarness({ env: { PUBLIC_WEB_URL: "https://trippr.test" } });
  anon = client(h.app);
  owner = await signIn(h.app, "Calendar Owner");
  editor = await signIn(h.app, "Calendar Editor");
  viewer = await signIn(h.app, "Calendar Viewer");
  leaver = await signIn(h.app, "Calendar Leaver");
  await owner.api.post(`/invites/${h.ownerInvite}/accept`);
  await invite("editor", editor);
  await invite("viewer", viewer);
  await invite("viewer", leaver);

  // A booked flight into Tokyo with a booking reference, and a timed activity there.
  let view = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
  tokyo = view.stops.find((s) => s.city.code === "TYO")!;
  const added = await owner.api.post<RouteView>(`/stops/${tokyo.id}/legs`, {
    mode: "flight",
    from: { kind: "airport", id: "YYZ" },
    to: { kind: "airport", id: "HND" },
    operator: "Air Canada",
    number: "AC 1",
    departAt: `${addDays(tokyo.arrive, -1)}T13:00-04:00`,
    arriveAt: `${tokyo.arrive}T15:30+09:00`,
    status: "booked",
    bookingRef: SECRET_REF,
    seat: "31K",
    version: view.route.version,
  });
  expect(added.status).toBe(201);
  view = added.body;
  legId = view.stops.find((s) => s.id === tokyo.id)!.legs.find((l) => l.number === "AC 1")!.id;
  activityId = (await owner.api.post<{ id: string }>("/activities", { tripId: TRIP, cityCode: "TYO", title: "Shibuya Sky, at sunset" })).body.id;
  const planned = await owner.api.put(`/stops/${tokyo.id}/plans/${activityId}`, { day: 2, startTime: "18:30", durationMin: 90 });
  expect(planned.status).toBe(200);
});

afterAll(async () => {
  await h?.close();
});

describe("calendar feed links", () => {
  it("starts with no feed and says who may include booking references", async () => {
    const asOwner = await owner.api.get<CalendarFeedStatus>(`/trips/${TRIP}/calendar`);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body).toMatchObject({ enabled: false, includePrivate: false, canIncludePrivate: true });
    expect((await viewer.api.get<CalendarFeedStatus>(`/trips/${TRIP}/calendar`)).body).toMatchObject({ enabled: false, canIncludePrivate: false });
    expect((await anon.get(`/trips/${TRIP}/calendar`)).status).toBe(401);
  });

  it("creates a link: https, webcal and Google Calendar", async () => {
    const res = await owner.api.post<CalendarFeedLink>(`/trips/${TRIP}/calendar`, {});
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(FEED_URL);
    expect(res.body.webcalUrl).toBe(res.body.url.replace(/^http:/, "webcal:"));
    expect(res.body.googleUrl).toBe(`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(res.body.webcalUrl)}`);
    expect(res.body.includePrivate).toBe(false);

    const status = await owner.api.get<CalendarFeedStatus>(`/trips/${TRIP}/calendar`);
    expect(status.body).toMatchObject({ enabled: true, includePrivate: false });
    // The token is only ever in the create response.
    const token = pathOf(res.body).slice(5, -4);
    expect(status.text).not.toContain(token);
  });

  it("serves the current route as a calendar, without signing in", async () => {
    const link = (await owner.api.post<CalendarFeedLink>(`/trips/${TRIP}/calendar`, {})).body;
    const res = await fetchFeed(pathOf(link));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/calendar; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("private, max-age=900");
    const ics = unfold(res.text);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/\r\nBEGIN:VEVENT\r\n/g)!.length).toBeGreaterThan(5);

    // The flight, in UTC from its stored offsets.
    expect(ics).toContain(`UID:leg-${legId}@trippr`);
    expect(ics).toContain(`DTSTART:${icsUtc(Date.parse(`${addDays(tokyo.arrive, -1)}T13:00-04:00`))}`);
    expect(ics).toContain(`DTEND:${icsUtc(Date.parse(`${tokyo.arrive}T15:30+09:00`))}`);
    // The Tokyo stay, all day from check-in to check-out.
    expect(ics).toContain(`UID:stay-${tokyo.id}@trippr\r\nDTSTAMP:`);
    expect(ics).toContain(`DTSTART;VALUE=DATE:${tokyo.arrive.replace(/-/g, "")}\r\nDTEND;VALUE=DATE:${tokyo.depart.replace(/-/g, "")}`);
    // The activity, timed in Asia/Tokyo, linked to Trippr and Google Maps.
    const start = localInstant(addDays(tokyo.arrive, 1), "18:30", "Asia/Tokyo")!;
    expect(ics).toContain(`UID:act-${tokyo.id}-${activityId}@trippr`);
    expect(ics).toContain(`DTSTART:${icsUtc(start)}\r\nDTEND:${icsUtc(start + 90 * 60_000)}`);
    expect(ics).toContain("SUMMARY:Shibuya Sky\\, at sunset");
    expect(ics).toContain("https://www.google.com/maps/search/?api=1&query=");
    expect(ics).toContain(`URL:https://trippr.test/trips/${TRIP}/itinerary`);
    // Booking references are off by default.
    expect(ics).not.toContain(SECRET_REF);
  });

  it("includes booking references only for editors who ask for them", async () => {
    const withRefs = await editor.api.post<CalendarFeedLink>(`/trips/${TRIP}/calendar`, { includePrivate: true });
    expect(withRefs.status).toBe(201);
    expect(withRefs.body.includePrivate).toBe(true);
    const ics = unfold((await fetchFeed(pathOf(withRefs.body))).text);
    expect(ics).toContain(`Booking reference: ${SECRET_REF}`);
    expect(ics).toContain("Seat: 31K");
    expect((await editor.api.get<CalendarFeedStatus>(`/trips/${TRIP}/calendar`)).body).toMatchObject({ enabled: true, includePrivate: true });
  });

  it("never lets a viewer's feed include booking references", async () => {
    const refused = await viewer.api.post(`/trips/${TRIP}/calendar`, { includePrivate: true });
    expect(refused.status).toBe(403);
    expect((await viewer.api.get<CalendarFeedStatus>(`/trips/${TRIP}/calendar`)).body.enabled).toBe(false);

    const link = (await viewer.api.post<CalendarFeedLink>(`/trips/${TRIP}/calendar`, {})).body;
    expect(link.includePrivate).toBe(false);
    const res = await fetchFeed(pathOf(link));
    expect(res.status).toBe(200);
    expect(res.text).toContain(`UID:leg-${legId}@trippr`);
    expect(unfold(res.text)).not.toContain(SECRET_REF);
    expect(unfold(res.text)).not.toContain("31K");
  });

  it("drops booking references when an editor is made a viewer", async () => {
    const link = (await editor.api.post<CalendarFeedLink>(`/trips/${TRIP}/calendar`, { includePrivate: true })).body;
    expect(unfold((await fetchFeed(pathOf(link))).text)).toContain(SECRET_REF);
    await owner.api.put(`/trips/${TRIP}/members/${editor.id}`, { role: "viewer" });
    const after = await fetchFeed(pathOf(link));
    expect(after.status).toBe(200);
    expect(unfold(after.text)).not.toContain(SECRET_REF);
    await owner.api.put(`/trips/${TRIP}/members/${editor.id}`, { role: "editor" });
  });

  it("kills the old link when a new one is made", async () => {
    const first = (await owner.api.post<CalendarFeedLink>(`/trips/${TRIP}/calendar`, {})).body;
    expect((await fetchFeed(pathOf(first))).status).toBe(200);
    const second = (await owner.api.post<CalendarFeedLink>(`/trips/${TRIP}/calendar`, {})).body;
    expect(second.url).not.toBe(first.url);
    expect((await fetchFeed(pathOf(first))).status).toBe(404);
    expect((await fetchFeed(pathOf(second))).status).toBe(200);
  });

  it("stops working for someone who is removed from the trip", async () => {
    const link = (await leaver.api.post<CalendarFeedLink>(`/trips/${TRIP}/calendar`, {})).body;
    expect((await fetchFeed(pathOf(link))).status).toBe(200);
    const removed = await owner.api.del(`/trips/${TRIP}/members/${leaver.id}`);
    expect(removed.status).toBe(200);
    expect((await fetchFeed(pathOf(link))).status).toBe(404);
    // Coming back doesn't bring the old link back.
    await invite("viewer", leaver);
    expect((await fetchFeed(pathOf(link))).status).toBe(404);
  });

  it("answers unknown tokens with a bare 404", async () => {
    for (const path of ["/cal/garbage.ics", `/cal/${"A".repeat(43)}.ics`, "/cal/not-a-feed", `/cal/${"b".repeat(43)}.txt`]) {
      const res = await fetchFeed(path);
      expect(res.status, path).toBe(404);
      expect(res.text).not.toContain("BEGIN:VCALENDAR");
    }
  });

  it("turns the feed off", async () => {
    const link = (await owner.api.post<CalendarFeedLink>(`/trips/${TRIP}/calendar`, {})).body;
    expect((await fetchFeed(pathOf(link))).status).toBe(200);
    expect((await owner.api.del(`/trips/${TRIP}/calendar`)).status).toBe(204);
    expect((await fetchFeed(pathOf(link))).status).toBe(404);
    expect((await owner.api.get<CalendarFeedStatus>(`/trips/${TRIP}/calendar`)).body.enabled).toBe(false);
  });

  it("keeps the demo account read-only and out of other trips", async () => {
    const demo = client(h.app, (await client(h.app).post("/auth/demo")).body.token);
    expect((await demo.get<CalendarFeedStatus>(`/trips/${TRIP}/calendar`)).body).toMatchObject({ enabled: false, canIncludePrivate: false });
    expect((await demo.post(`/trips/${TRIP}/calendar`, {})).status).toBe(403);
    const stranger = await signIn(h.app, "Calendar Stranger");
    expect((await stranger.api.post(`/trips/${TRIP}/calendar`, {})).status).toBe(404);
  });
});
