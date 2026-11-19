import type { BookingsResult, InboxItem, InboxResult, LegPrivate, LibraryActivity, RouteView } from "@trippr/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Extracted, InboxReader } from "../src/services/inbox/reader";
import { client, signIn, startHarness, type Harness } from "./harness";

const TRIP = "asia-2027";
const MAIN = "route-main";
const SECRET = "inbound-secret-0123456789";

/** Stands in for Claude: returns whatever the test queues next. */
let next: Extracted | Error = { items: [] };
const fakeReader: InboxReader = {
  name: "claude",
  async read() {
    if (next instanceof Error) throw next;
    return next;
  },
};

let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;
let viewer: Awaited<ReturnType<typeof signIn>>;
let sia: RouteView["stops"][number];

const leg = (over: Partial<NonNullable<Extracted["items"][number]["leg"]>> = {}) => ({
  kind: "leg" as const,
  summary: "Train G89 Beijing West → Xi'an North",
  stay: null,
  activity: null,
  leg: {
    mode: "hsr" as const,
    status: "booked" as const,
    fromCityCode: "BJS",
    toCityCode: "SIA",
    fromName: "Beijing West",
    toName: "Xi'an North",
    fromAirport: null,
    toAirport: null,
    operator: "China Railway",
    number: "G89",
    departAt: `${sia.arrive}T09:00+08:00`,
    arriveAt: `${sia.arrive}T13:30+08:00`,
    pricePerPersonCad: 120,
    bookingRef: "E99887766",
    seat: "05C",
    ...over,
  },
});

beforeAll(async () => {
  h = await startHarness({
    inboxReader: fakeReader,
    env: { INBOX_WEBHOOK_SECRET: SECRET, INBOX_EMAIL_ADDRESS: "abc123@inbound.postmarkapp.com" },
  });
  owner = await signIn(h.app, "Inbox Owner");
  viewer = await signIn(h.app, "Inbox Viewer");
  await owner.api.post(`/invites/${h.ownerInvite}/accept`);
  const invite = await owner.api.post(`/trips/${TRIP}/invites`, { role: "viewer" });
  await viewer.api.post(`/invites/${invite.body.token}/accept`);
  sia = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body.stops.find((s) => s.city.code === "SIA")!;
});

afterAll(async () => {
  await h?.close();
});

describe("trip inbox", () => {
  it("adds a pasted ticket, hotel and idea to the matching stop", async () => {
    next = {
      items: [
        leg(),
        {
          kind: "stay",
          summary: "Inbox Hotel, Xi'an",
          leg: null,
          activity: null,
          stay: {
            status: "booked",
            hotelName: "Inbox Hotel Xi'an",
            cityCode: "SIA",
            areaName: "Muslim Quarter",
            checkIn: sia.arrive,
            checkOut: sia.depart,
            rooms: 3,
            perNightCad: 90,
            url: "https://example.com/inbox-hotel",
            bookingRef: "H-555",
          },
        },
        {
          kind: "activity",
          summary: "Terracotta Warriors at night, Xi'an (from TikTok)",
          leg: null,
          stay: null,
          activity: {
            title: "Terracotta Warriors night tour",
            cityCode: "sia",
            url: "https://www.tiktok.com/@someone/video/123",
            tags: ["History", "not a tag!"],
            costCad: 40,
            note: "Fewer crowds after dark.",
          },
        },
      ],
    };
    const res = await owner.api.post<InboxItem[]>(`/trips/${TRIP}/inbox`, { text: "Your booking is confirmed…" });
    expect(res.status).toBe(201);
    expect(res.body.map((i) => [i.kind, i.status])).toEqual([
      ["leg", "applied"],
      ["stay", "applied"],
      ["activity", "applied"],
    ]);
    expect(res.body[0]!.stopLabel).toBe(`Xi'an (stop ${sia.order + 1})`);

    const view = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const stop = view.stops.find((s) => s.id === sia.id)!;
    const added = stop.legs.find((l) => l.number === "G89")!;
    expect(added).toMatchObject({ mode: "hsr", status: "booked", priceCad: 120, departAt: `${sia.arrive}T09:00+08:00` });
    expect((await owner.api.get<LegPrivate>(`/legs/${added.id}/private`)).body).toMatchObject({ bookingRef: "E99887766", seat: "05C" });
    expect(stop.stays.find((s) => s.hotel.name === "Inbox Hotel Xi'an")).toMatchObject({ status: "booked", rooms: 3 });

    const ideas = (await owner.api.get<LibraryActivity[]>(`/cities/SIA/activities?tripId=${TRIP}`)).body;
    const idea = ideas.find((a) => a.title === "Terracotta Warriors night tour")!;
    expect(idea).toMatchObject({ url: "https://www.tiktok.com/@someone/video/123", costCad: 40 });
    expect(idea.tags).toEqual(["history"]);
    const comments = await owner.api.get<{ text: string }[]>(`/activities/${idea.id}/comments`);
    expect(comments.body.map((c) => c.text)).toContain("From the inbox: Fewer crowds after dark.");

    const booked = (await owner.api.get<BookingsResult>(`/trips/${TRIP}/bookings`)).body;
    expect(booked.booked.some((i) => i.kind === "leg" && i.number === "G89")).toBe(true);
  });

  it("doesn't add the same ticket twice", async () => {
    next = { items: [leg()] };
    const [item] = (await owner.api.post<InboxItem[]>(`/trips/${TRIP}/inbox`, { text: "Forwarded again" })).body;
    expect(item).toMatchObject({ status: "applied" });
    expect(item!.note).toContain("already on");
    const stop = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body.stops.find((s) => s.id === sia.id)!;
    expect(stop.legs.filter((l) => l.number === "G89")).toHaveLength(1);
  });

  it("waits for a stop when the place isn't on the route, then adds it where you say", async () => {
    next = { items: [leg({ number: "TG1", toCityCode: "BKK", toName: "Bangkok Hua Lamphong", departAt: null, arriveAt: null })] };
    const [item] = (await owner.api.post<InboxItem[]>(`/trips/${TRIP}/inbox`, { text: "Train to Bangkok" })).body;
    expect(item).toMatchObject({ status: "pending", stopId: null });
    expect(item!.note).toContain("Bangkok isn't on the current route");

    const accepted = await owner.api.post<InboxItem>(`/inbox/${item!.id}/accept`, { stopId: sia.id });
    expect(accepted.body).toMatchObject({ status: "applied", stopId: sia.id });
    const stop = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body.stops.find((s) => s.id === sia.id)!;
    expect(stop.legs.some((l) => l.number === "TG1")).toBe(true);
  });

  it("records a reader failure and lets you dismiss it", async () => {
    next = new Error("overloaded");
    const [item] = (await owner.api.post<InboxItem[]>(`/trips/${TRIP}/inbox`, { text: "Something", subject: "Hello" })).body;
    expect(item).toMatchObject({ kind: "unknown", status: "failed", summary: "Hello" });
    expect(item!.note).toContain("overloaded");
    expect((await owner.api.post<InboxItem>(`/inbox/${item!.id}/dismiss`)).body.status).toBe("dismissed");
  });

  it("is for editors only", async () => {
    expect((await viewer.api.get(`/trips/${TRIP}/inbox`)).status).toBe(403);
    expect((await viewer.api.post(`/trips/${TRIP}/inbox`, { text: "hi" })).status).toBe(403);
    const stranger = await signIn(h.app, "Inbox Stranger");
    expect((await stranger.api.get(`/trips/${TRIP}/inbox`)).status).toBe(404);
    const list = (await owner.api.get<InboxResult>(`/trips/${TRIP}/inbox`)).body;
    expect((await viewer.api.post(`/inbox/${list.items[0]!.id}/accept`, {})).status).toBe(403);
  });

  it("gives the trip an email address and reads mail sent to it", async () => {
    const list = (await owner.api.get<InboxResult>(`/trips/${TRIP}/inbox`)).body;
    expect(list.reader).toBe("claude");
    expect(list.address).toMatch(/^abc123\+[\w-]+@inbound\.postmarkapp\.com$/);
    const token = list.address!.split("+")[1]!.split("@")[0]!;
    await owner.api.patch("/me", { email: "owner@example.com" });

    const mail = (over: Record<string, unknown> = {}) => ({
      FromFull: { Email: "Owner@Example.com", Name: "Inbox Owner" },
      MailboxHash: token,
      Subject: "Fwd: Your train",
      TextBody: "Booking confirmed",
      Headers: [{ Name: "Received-SPF", Value: "Pass (sender SPF authorized)" }],
      ...over,
    });
    const anon = client(h.app);
    expect((await anon.post(`/inbound/postmark?secret=wrong-secret-value-123`, mail())).status).toBe(403);

    next = { items: [leg({ number: "G91", departAt: `${sia.arrive}T15:00+08:00`, arriveAt: null })] };
    const before = (await owner.api.get<InboxResult>(`/trips/${TRIP}/inbox`)).body.items.length;
    expect((await anon.post(`/inbound/postmark?secret=${SECRET}`, mail())).status).toBe(200);
    let items = (await owner.api.get<InboxResult>(`/trips/${TRIP}/inbox`)).body.items;
    expect(items.length).toBe(before + 1);
    expect(items[0]).toMatchObject({ source: "email", status: "applied", from: "Owner@Example.com" });

    // Someone who isn't on the trip: kept for an editor to look at, never added on its own.
    next = { items: [leg({ number: "G93" })] };
    await anon.post(`/inbound/postmark?secret=${SECRET}`, mail({ FromFull: { Email: "stranger@example.com" } }));
    items = (await owner.api.get<InboxResult>(`/trips/${TRIP}/inbox`)).body.items;
    expect(items[0]).toMatchObject({ status: "pending" });
    expect(items[0]!.note).toContain("isn't on this trip");

    // A sender whose SPF/DKIM didn't pass is treated the same way.
    next = { items: [leg({ number: "G95" })] };
    await anon.post(`/inbound/postmark?secret=${SECRET}`, mail({ Headers: [] }));
    items = (await owner.api.get<InboxResult>(`/trips/${TRIP}/inbox`)).body.items;
    expect(items[0]).toMatchObject({ status: "pending" });

    // An unknown address is accepted and dropped.
    const count = items.length;
    expect((await anon.post(`/inbound/postmark?secret=${SECRET}`, mail({ MailboxHash: "nope" }))).status).toBe(200);
    expect((await owner.api.get<InboxResult>(`/trips/${TRIP}/inbox`)).body.items.length).toBe(count);

    // A new address retires the old one.
    const rotated = await owner.api.post<{ address: string }>(`/trips/${TRIP}/inbox/address`);
    expect(rotated.body.address).not.toContain(token);
    expect((await viewer.api.post(`/trips/${TRIP}/inbox/address`)).status).toBe(403);
  });
});

describe("trip inbox without Claude", () => {
  let plain: Harness;
  beforeAll(async () => {
    plain = await startHarness();
  });
  afterAll(async () => {
    await plain?.close();
  });

  it("turns a link into an idea in the city the message names", async () => {
    const me = await signIn(plain.app, "Plain Owner");
    await me.api.post(`/invites/${plain.ownerInvite}/accept`);
    const res = await me.api.post<InboxItem[]>(`/trips/${TRIP}/inbox`, {
      text: "Shibuya Sky in Tokyo looks unreal\nhttps://www.tiktok.com/@traveller/video/42",
    });
    expect(res.status).toBe(201);
    expect(res.body[0]).toMatchObject({ kind: "activity", status: "applied" });
    expect(res.body[0]!.suggestion).toMatchObject({ title: "Shibuya Sky in Tokyo looks unreal", cityCode: "TYO", tags: ["social"] });
    expect((await me.api.get<InboxResult>(`/trips/${TRIP}/inbox`)).body).toMatchObject({ reader: "basic", address: null });

    const note = await me.api.post<InboxItem[]>(`/trips/${TRIP}/inbox`, { text: "Flight AC1 confirmed, ref ABC123" });
    expect(note.body[0]).toMatchObject({ kind: "unknown", status: "pending" });
    expect(note.body[0]!.note).toContain("Claude");
    expect((await client(plain.app).post("/inbound/postmark", {})).status).toBe(404);
  });
});
