import type { InboxItem, InboxResult, LibraryActivity } from "@trippr/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LookupInput, LookupResult, PlaceLookup } from "../src/services/inbox/lookup";
import type { Extracted, InboxReader } from "../src/services/inbox/reader";
import type { GeoQuery, GeoResult, Geocoder } from "../src/services/places/geocoder";
import { client, signIn, startHarness, type Harness } from "./harness";

const TRIP = "asia-2027";
const SECRET = "inbound-secret-lookup-0123456789";

/** Stands in for the inbox reader: returns whatever the test queues next. */
let nextRead: Extracted = { items: [] };
const fakeReader: InboxReader = { name: "claude", read: async () => nextRead };

/** Stands in for Claude with web search: answers by title and records what it was asked. */
const answers = new Map<string, LookupResult | null | Error>();
const lookups: LookupInput[] = [];
const fakeLookup: PlaceLookup = {
  name: "fake",
  async lookup(input) {
    lookups.push(input);
    const answer = answers.get(input.title);
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  },
};

/** Stands in for OpenStreetMap. */
const points = new Map<string, GeoResult>();
const geocoded: GeoQuery[] = [];
const fakeGeocoder: Geocoder = {
  name: "fake-lookup",
  async search(query) {
    geocoded.push(query);
    return points.get(query.text) ?? null;
  },
};

const idea = (title: string, url: string | null, cityCode: string | null = "TYO"): Extracted["items"][number] => ({
  kind: "activity",
  summary: `${title} (from the inbox)`,
  leg: null,
  stay: null,
  activity: { title, cityCode, url, tags: ["view"], costCad: null, note: null },
});

const answer = (over: Partial<LookupResult> = {}): LookupResult => ({
  placeName: null,
  address: null,
  cityCode: null,
  website: null,
  ticketUrl: null,
  reserveUrl: null,
  eventDate: null,
  confidence: "high",
  evidence: ["Found on the official site."],
  seenUrls: [],
  ...over,
});

let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;

const activity = async (id: string) => (await owner.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`)).body.find((a) => a.id === id)!;
const activityTitled = async (title: string) => (await owner.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`)).body.find((a) => a.title === title);
const paste = async (text: string) => {
  const res = await owner.api.post<InboxItem[]>(`/trips/${TRIP}/inbox`, { text });
  expect(res.status).toBe(201);
  return res.body;
};

beforeAll(async () => {
  h = await startHarness({
    inboxReader: fakeReader,
    placeLookup: fakeLookup,
    geocoder: fakeGeocoder,
    env: { INBOX_LOOKUP: "on", INBOX_WEBHOOK_SECRET: SECRET, INBOX_EMAIL_ADDRESS: "abc123@inbound.postmarkapp.com" },
  });
  owner = await signIn(h.app, "Lookup Owner");
  await owner.api.post(`/invites/${h.ownerInvite}/accept`);
});

afterAll(async () => {
  await h?.close();
});

describe("inbox link lookup", () => {
  it("turns a pasted TikTok into an idea with its website, tickets and a pin when the lookup is confident", async () => {
    const tiktok = "https://www.tiktok.com/@traveller/video/7300000000000000001";
    nextRead = { items: [idea("teamLab Planets", tiktok)] };
    answers.set(
      "teamLab Planets",
      Object.assign(
        answer({
          placeName: "teamLab Planets TOKYO",
          address: "6-1-16 Toyosu, Koto City, Tokyo",
          cityCode: "TYO",
          website: "https://www.teamlab.art/e/planets/",
          ticketUrl: "https://ticket.teamlab.art/planets/",
          seenUrls: ["https://www.teamlab.art/e/planets/", "https://ticket.teamlab.art/planets/?lang=en"],
        }),
        // The model's own coordinates must never be used.
        { lat: 1.23, lon: 4.56 },
      ),
    );
    points.set("teamLab Planets TOKYO, 6-1-16 Toyosu, Koto City, Tokyo", {
      lat: 35.6491,
      lon: 139.7898,
      address: "teamLab Planets TOKYO, Toyosu, Koto, Tokyo, Japan",
      osmId: "way/42",
    });

    const [item] = await paste(`This looks unreal in Tokyo ${tiktok}`);
    expect(item).toMatchObject({ kind: "activity", status: "applied", lookup: "done" });
    expect(item!.suggestion).toMatchObject({
      place: { website: "https://www.teamlab.art/e/planets/", ticketUrl: "https://ticket.teamlab.art/planets/", placeStatus: "placed", confidence: "high" },
    });
    expect(lookups.at(-1)).toMatchObject({ kind: "activity", title: "teamLab Planets", city: { code: "TYO", name: "Tokyo" }, link: { url: tiktok, kind: "social" } });
    expect(geocoded.at(-1)).toMatchObject({ countryIso: "JP" });
    expect(geocoded.at(-1)!.near).toBeDefined();

    const added = await activityTitled("teamLab Planets");
    expect(added).toMatchObject({
      url: tiktok,
      website: "https://www.teamlab.art/e/planets/",
      ticketUrl: "https://ticket.teamlab.art/planets/",
      lat: 35.6491,
      lon: 139.7898,
      placeStatus: "placed",
    });
    expect(added!.lat).not.toBe(1.23);
    expect((item!.suggestion as { activityId?: string }).activityId).toBe(added!.id);

    const list = (await owner.api.get<InboxResult>(`/trips/${TRIP}/inbox`)).body;
    expect(list.lookup).toBe(true);
  });

  it("adds the idea but leaves the pin for a person when the lookup is only fairly sure", async () => {
    nextRead = { items: [idea("Hidden ramen counter", "https://www.instagram.com/reel/abc123/")] };
    answers.set("Hidden ramen counter", answer({ placeName: "Ramen Kazu", address: "1-2-3 Shinjuku, Tokyo", confidence: "medium" }));
    points.set("Ramen Kazu, 1-2-3 Shinjuku, Tokyo", { lat: 35.6938, lon: 139.7034, address: "Ramen Kazu, Shinjuku, Tokyo, Japan", osmId: null });

    const [item] = await paste("https://www.instagram.com/reel/abc123/");
    expect(item).toMatchObject({ status: "applied", lookup: "done" });
    expect(item!.note).toContain("Check the pin");
    expect(await activity((item!.suggestion as { activityId: string }).activityId)).toMatchObject({ placeStatus: "check", lat: 35.6938 });
  });

  it("asks a person to check a pin whose name doesn't match, even when the lookup is sure", async () => {
    nextRead = { items: [idea("Sky deck", "https://www.youtube.com/shorts/xyz")] };
    answers.set("Sky deck", answer({ placeName: "Shibuya Sky", address: null, confidence: "high" }));
    points.set("Shibuya Sky, Tokyo", { lat: 35.6585, lon: 139.7022, address: "Some Other Tower, Minato, Tokyo, Japan", osmId: null });
    const [item] = await paste("https://www.youtube.com/shorts/xyz");
    expect(await activity((item!.suggestion as { activityId: string }).activityId)).toMatchObject({ placeStatus: "check" });
  });

  it("drops links the lookup never saw in a search or fetch result, and unsafe ones", async () => {
    nextRead = { items: [idea("Rooftop bar", "https://www.tiktok.com/@a/video/2")] };
    answers.set(
      "Rooftop bar",
      answer({
        placeName: "Rooftop Bar Ginza",
        address: "Ginza, Tokyo",
        website: "https://rooftop-bar-ginza.example.com/",
        ticketUrl: "http://tickets.example.com/rooftop",
        reserveUrl: "https://127.0.0.1/reserve",
        seenUrls: ["https://www.timeout.com/tokyo/bars/rooftop", "http://tickets.example.com/rooftop"],
      }),
    );
    const [item] = await paste("https://www.tiktok.com/@a/video/2");
    expect(item).toMatchObject({ status: "applied", lookup: "done" });
    expect(item!.suggestion).toMatchObject({ place: { website: null, ticketUrl: null, reserveUrl: null } });
    const added = await activity((item!.suggestion as { activityId: string }).activityId);
    expect(added).toMatchObject({ website: null, ticketUrl: null, reserveUrl: null, url: "https://www.tiktok.com/@a/video/2" });
  });

  it("keeps a ticket link from the message, sets the event date, and keeps a shared Google Maps link", async () => {
    const klook = "https://www.klook.com/en-CA/activity/9999-summer-sonic-tokyo/";
    const maps = "https://maps.app.goo.gl/AbCdEf123";
    nextRead = { items: [idea("Summer festival", klook), idea("Tiny shrine", maps)] };
    answers.set("Summer festival", answer({ placeName: "Makuhari Messe", address: "2-1 Nakase, Mihama, Chiba", eventDate: "2027-05-15" }));
    answers.set("Tiny shrine", answer({ placeName: "Tiny shrine", confidence: "medium" }));
    const items = await paste(`${klook}\n${maps}`);
    expect(items.map((i) => i.lookup)).toEqual(["done", "done"]);

    const festival = await activity((items[0]!.suggestion as { activityId: string }).activityId);
    expect(festival).toMatchObject({ ticketUrl: klook, when: { on: "2027-05-15" }, placeStatus: "not_found" });
    const shrine = await activity((items[1]!.suggestion as { activityId: string }).activityId);
    expect(shrine).toMatchObject({ mapsUrl: maps, url: maps });
  });

  it("marks a lookup that finds nothing as failed, and a retry fills the idea in", async () => {
    nextRead = { items: [idea("Mystery cafe", "https://www.xiaohongshu.com/explore/abc")] };
    answers.set("Mystery cafe", null);
    const [item] = await paste("https://www.xiaohongshu.com/explore/abc");
    expect(item).toMatchObject({ status: "applied", lookup: "failed" });
    const id = (item!.suggestion as { activityId: string }).activityId;
    expect(await activity(id)).toMatchObject({ placeStatus: "unplaced", website: null });

    answers.set("Mystery cafe", answer({ placeName: "Cafe Mystery", address: "Nakameguro, Tokyo", website: "https://cafe-mystery.jp/", seenUrls: ["https://cafe-mystery.jp/menu"] }));
    points.set("Cafe Mystery, Nakameguro, Tokyo", { lat: 35.644, lon: 139.699, address: "Cafe Mystery, Nakameguro, Meguro, Tokyo, Japan", osmId: null });
    const retried = await owner.api.post<InboxItem>(`/inbox/${item!.id}/lookup`);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ status: "applied", lookup: "done", suggestion: { place: { website: "https://cafe-mystery.jp/" } } });
    expect(await activity(id)).toMatchObject({ website: "https://cafe-mystery.jp/", placeStatus: "placed", lat: 35.644 });
  });

  it("records an error or a slow lookup as failed without losing the idea", async () => {
    nextRead = { items: [idea("Broken lookup", "https://www.tiktok.com/@a/video/3")] };
    answers.set("Broken lookup", new Error("overloaded"));
    const [item] = await paste("https://www.tiktok.com/@a/video/3");
    expect(item).toMatchObject({ status: "applied", lookup: "failed" });
  });

  it("looks up at most five places per message and never looks up tickets", async () => {
    nextRead = {
      items: [
        ...["One", "Two", "Three", "Four", "Five", "Six"].map((n) => idea(`Listicle spot ${n}`, "https://www.timeout.com/tokyo/best-spots")),
        {
          kind: "leg",
          summary: "Flight",
          stay: null,
          activity: null,
          leg: {
            mode: "flight",
            status: "held",
            fromCityCode: null,
            toCityCode: "TYO",
            fromName: null,
            toName: null,
            fromAirport: "YYZ",
            toAirport: "HND",
            operator: null,
            number: "AC9",
            departAt: null,
            arriveAt: null,
            pricePerPersonCad: null,
            bookingRef: null,
            seat: null,
          },
        },
      ],
    };
    const before = lookups.length;
    const items = await paste("Ten great spots https://www.timeout.com/tokyo/best-spots");
    expect(lookups.length - before).toBe(5);
    expect(items.filter((i) => i.lookup === "skipped").map((i) => i.kind).sort()).toEqual(["activity", "leg"]);
  });

  it("takes the city from the lookup when the reader couldn't tell", async () => {
    nextRead = { items: [idea("Some viewpoint", "https://www.tiktok.com/@a/video/4", null)] };
    answers.set("Some viewpoint", answer({ placeName: "Some viewpoint", cityCode: "tyo", confidence: "low" }));
    const [item] = await paste("https://www.tiktok.com/@a/video/4");
    expect(item!.suggestion).toMatchObject({ cityCode: "TYO" });
    expect(item).toMatchObject({ status: "applied" });
  });

  it("looks up mail sent to the trip address, and waits for an editor when the sender isn't trusted", async () => {
    const list = (await owner.api.get<InboxResult>(`/trips/${TRIP}/inbox`)).body;
    const token = list.address!.split("+")[1]!.split("@")[0]!;
    await owner.api.patch("/me", { email: "lookup-owner@example.com" });
    const mail = (over: Record<string, unknown> = {}) => ({
      FromFull: { Email: "lookup-owner@example.com", Name: "Lookup Owner" },
      MailboxHash: token,
      Subject: "Look at this",
      TextBody: "https://www.tiktok.com/@a/video/5",
      Headers: [{ Name: "Received-SPF", Value: "Pass" }],
      ...over,
    });
    const anon = client(h.app);

    nextRead = { items: [idea("Emailed tower", "https://www.tiktok.com/@a/video/5")] };
    answers.set("Emailed tower", answer({ placeName: "Emailed Tower", address: "Minato, Tokyo", website: "https://emailed-tower.jp/", seenUrls: ["https://emailed-tower.jp/"] }));
    points.set("Emailed Tower, Minato, Tokyo", { lat: 35.6586, lon: 139.7454, address: "Emailed Tower, Minato, Tokyo, Japan", osmId: null });
    expect((await anon.post(`/inbound/postmark?secret=${SECRET}`, mail())).status).toBe(200);
    let items = (await owner.api.get<InboxResult>(`/trips/${TRIP}/inbox`)).body.items;
    expect(items[0]).toMatchObject({ source: "email", status: "applied", lookup: "done" });
    expect(await activityTitled("Emailed tower")).toMatchObject({ website: "https://emailed-tower.jp/", placeStatus: "placed" });

    nextRead = { items: [idea("Stranger tip", "https://www.tiktok.com/@a/video/6")] };
    answers.set("Stranger tip", answer({ placeName: "Stranger Tip Cafe", address: "Asakusa, Tokyo", website: "https://stranger-tip.jp/", seenUrls: ["https://stranger-tip.jp/"] }));
    points.set("Stranger Tip Cafe, Asakusa, Tokyo", { lat: 35.7148, lon: 139.7967, address: "Stranger Tip Cafe, Asakusa, Taito, Tokyo, Japan", osmId: null });
    await anon.post(`/inbound/postmark?secret=${SECRET}`, mail({ FromFull: { Email: "stranger@example.com" } }));
    items = (await owner.api.get<InboxResult>(`/trips/${TRIP}/inbox`)).body.items;
    expect(items[0]).toMatchObject({ status: "pending", lookup: "done", suggestion: { place: { website: "https://stranger-tip.jp/" } } });
    expect(await activityTitled("Stranger tip")).toBeUndefined();

    const accepted = await owner.api.post<InboxItem>(`/inbox/${items[0]!.id}/accept`, {});
    expect(accepted.body).toMatchObject({ status: "applied" });
    expect(await activityTitled("Stranger tip")).toMatchObject({ website: "https://stranger-tip.jp/", placeStatus: "placed", lat: 35.7148 });
  });
});

describe("inbox with the lookup turned off", () => {
  let off: Harness;
  let calls = 0;
  beforeAll(async () => {
    off = await startHarness({
      inboxReader: fakeReader,
      placeLookup: {
        name: "fake",
        lookup: async () => {
          calls++;
          return null;
        },
      },
      geocoder: fakeGeocoder,
    });
  });
  afterAll(async () => {
    await off?.close();
  });

  it("works as before: the link only, no lookup, no pin", async () => {
    const me = await signIn(off.app, "Lookup Off Owner");
    await me.api.post(`/invites/${off.ownerInvite}/accept`);
    nextRead = { items: [idea("Plain idea", "https://www.tiktok.com/@a/video/7")] };
    const res = await me.api.post<InboxItem[]>(`/trips/${TRIP}/inbox`, { text: "https://www.tiktok.com/@a/video/7" });
    expect(res.body[0]).toMatchObject({ status: "applied", lookup: "skipped" });
    expect(calls).toBe(0);
    const added = (await me.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`)).body.find((a) => a.title === "Plain idea");
    expect(added).toMatchObject({ url: "https://www.tiktok.com/@a/video/7", website: null, placeStatus: "unplaced" });
    expect((await me.api.get<InboxResult>(`/trips/${TRIP}/inbox`)).body.lookup).toBe(false);
    expect((await me.api.post(`/inbox/${res.body[0]!.id}/lookup`)).status).toBe(503);
  });
});
