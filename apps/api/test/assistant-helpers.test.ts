import type { BookingsResult, Hotel, LibraryActivity, RouteView, TripDetail } from "@trippr/contracts";
import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  compact,
  dedupeCitations,
  historyMessages,
  MAX_TOOL_RESULT_CHARS,
  nearby,
  parseRefs,
  RefsSplitter,
  Seen,
  toolJson,
  trimActivities,
  trimBookings,
} from "../src/services/assistant/helpers";
import { prepareTool, toolDefinitions, ToolError, type ToolContext } from "../src/services/assistant/tools";

// Pure helpers only: no database, so this file also runs without Docker
// (pnpm --filter @trippr/api exec vitest run test/assistant-helpers.test.ts).

const tokyo = { code: "TYO", name: "Tokyo", lat: 35.68, lon: 139.76, countryIso: "JP", countryName: "Japan", tz: "Asia/Tokyo" };
const osaka = { code: "OSA", name: "Osaka", lat: 34.69, lon: 135.5, countryIso: "JP", countryName: "Japan", tz: "Asia/Tokyo" };

const view = {
  route: { id: "route-main", tripId: "asia-2027", name: "Main", tags: ["current"], isCurrent: true, version: 3, createdAt: "2026-01-01" },
  trip: { id: "asia-2027", name: "Asia 2027", startDate: "2027-05-09", travellers: 4 },
  role: "viewer",
  stops: [
    {
      id: "stop-tyo",
      order: 0,
      nights: 4,
      arriveMode: "flight",
      arrive: "2027-05-09",
      depart: "2027-05-13",
      city: tokyo,
      country: { iso: "JP", name: "Japan" },
      planned: [{ id: "act-sky", title: "Shibuya Sky", day: 2, startTime: "18:30" }],
      legs: [
        {
          id: "leg-1",
          seq: 0,
          mode: "flight",
          from: { id: "YYZ", name: "Toronto Pearson" },
          to: { id: "HND", name: "Tokyo Haneda" },
          number: "AC1",
          status: "booked",
        },
      ],
      stays: [{ status: "booked", hotel: { id: "hotel-1", name: "Hotel Gracery", areaName: "Shinjuku", lat: 35.69, lon: 139.7 } }],
    },
    {
      id: "stop-osa",
      order: 1,
      nights: 3,
      arriveMode: "hsr",
      arrive: "2027-05-13",
      depart: "2027-05-16",
      city: osaka,
      country: { iso: "JP", name: "Japan" },
      planned: [],
      legs: [],
      stays: [],
    },
  ],
  checks: { level: "warn", totalNights: 7, returnDate: "2027-05-16", checks: [{ id: "c1", kind: "x", level: "warn", title: "No hotel in Osaka", detail: "" }], visa: [], events: [] },
  plannedCostCad: 0,
  budget: { travellers: 4, perPerson: { stay: 400, travel: 900, activities: 40, total: 1340.4 }, group: { stay: 0, travel: 0, activities: 0, total: 0 }, missing: {} },
} as unknown as RouteView;

const detail = {
  trip: view.trip,
  role: "viewer",
  members: [
    { id: "u1", name: "Brady", role: "owner" },
    { id: "u2", name: "Sam", role: "viewer" },
  ],
  routes: [
    { id: "route-main", name: "Main", tags: ["current"], isCurrent: true, stopCount: 2, totalNights: 7, returnDate: "2027-05-16", perPersonCad: 1340.4, cities: ["TYO", "OSA"] },
    { id: "route-alt", name: "With Seoul", tags: [], isCurrent: false, stopCount: 3, totalNights: 9, returnDate: "2027-05-18", perPersonCad: 1600, cities: ["TYO", "SEL", "OSA"] },
  ],
} as unknown as TripDetail;

describe("trip snapshot", () => {
  it("lists routes, the current route's stops with dates and nights, and counts", () => {
    const seen = new Seen();
    const text = buildSnapshot(detail, view, seen);
    expect(text).toContain("Trip: Asia 2027 (id asia-2027). Starts 2027-05-09. 4 travellers.");
    expect(text).toContain("route-main | Main [current]");
    expect(text).toContain("route-alt | With Seoul");
    expect(text).toContain("1. stop-tyo | Tokyo (TYO, Japan) | 2027-05-09 → 2027-05-13 | 4 | flight (1/1 tickets booked) | Hotel Gracery (booked) | 1");
    expect(text).toContain("2. stop-osa | Osaka (OSA, Japan) | 2027-05-13 → 2027-05-16 | 3 | hsr | none yet | 0");
    expect(text).toContain("2 stops, 7 nights, back 2027-05-16, 1 planned activity, 1/1 tickets booked, 1/2 stops with a booked hotel");
    expect(text).toContain("No hotel in Osaka (warn)");
    // Ids it showed may come back as references.
    expect([...seen.stops.keys()]).toEqual(["stop-tyo", "stop-osa"]);
    expect(seen.activities.get("act-sky")).toBe("Shibuya Sky");
    expect(seen.legs.has("leg-1")).toBe(true);
    expect(seen.hotels.get("hotel-1")).toBe("Hotel Gracery");
  });

  it("is the same text every time, so the prompt cache holds", () => {
    expect(buildSnapshot(detail, view, new Seen())).toBe(buildSnapshot(detail, view, new Seen()));
    expect(buildSnapshot(detail, view, new Seen())).not.toMatch(/today/i);
  });

  it("copes with a trip that has no routes", () => {
    expect(buildSnapshot({ ...detail, routes: [] }, null, new Seen())).toContain("The trip has no routes yet.");
  });
});

describe("tool results", () => {
  it("drops empty fields and cuts very long results", () => {
    expect(compact({ a: 1, b: null, c: "", d: [], e: { f: undefined, g: [null, 2] } })).toEqual({ a: 1, e: { g: [null, 2] } });
    const long = toolJson({ text: "x".repeat(MAX_TOOL_RESULT_CHARS * 2) });
    expect(long.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 100);
    expect(long).toContain("(cut; ask a narrower question)");
  });

  const leg = (extra: object) => ({
    kind: "leg",
    id: "leg-9",
    stopId: "stop-osa",
    stopOrder: 1,
    cityCode: "OSA",
    cityName: "Osaka",
    status: "booked",
    mode: "hsr",
    from: { id: "s1", name: "Tokyo", kind: "station" },
    to: { id: "s2", name: "Shin-Osaka", kind: "station" },
    number: "N700",
    date: "2027-05-13",
    pricePerPersonCad: 140,
    groupCad: 560,
    ...extra,
  });
  const bookings = (canSeePrivate: boolean, extra: object) =>
    ({
      trip: { id: "asia-2027", name: "Asia 2027", travellers: 4 },
      route: { id: "route-main", name: "Main", isCurrent: true },
      routes: [],
      canSeePrivate,
      booked: [leg(extra)],
      pending: [],
      toBook: [],
      totals: { bookedPerPersonCad: 140, pendingPerPersonCad: 0, bookedGroupCad: 560, bookedCount: 1, pendingCount: 0 },
    }) as unknown as BookingsResult;

  it("keeps booking references for editors and never passes them on otherwise", () => {
    const editor = JSON.stringify(trimBookings(bookings(true, { bookingRef: "E123", seat: "07A" }), new Seen()));
    expect(editor).toContain("E123");
    expect(editor).toContain("07A");
    // Even if a reference slipped into a viewer's result, the trimmed one drops it.
    const viewer = JSON.stringify(trimBookings(bookings(false, { bookingRef: "E123", seat: "07A" }), new Seen()));
    expect(viewer).not.toContain("E123");
    expect(viewer).not.toContain("07A");
  });

  it("filters activity ideas by city, tag, words and planned", () => {
    const act = (id: string, title: string, cityCode: string, tags: string[], plannedIn: string[], votes = 0) =>
      ({ id, title, cityCode, cityName: cityCode, tags, votes, plannedIn: plannedIn.map((r) => ({ routeId: r, routeName: r, stopId: "s" })) }) as unknown as LibraryActivity;
    const list = [
      act("a1", "Shibuya Sky", "TYO", ["view"], ["route-main"], 3),
      act("a2", "Tsukiji breakfast", "TYO", ["food"], []),
      act("a3", "Dotonbori food crawl", "OSA", ["food", "nightlife"], ["route-alt"]),
    ];
    const ids = (f: Parameters<typeof trimActivities>[1]) => trimActivities(list, f, "route-main", new Seen()).activities.map((a) => a.id);
    expect(ids({ cityCode: "TYO" })).toEqual(["a1", "a2"]);
    expect(ids({ tags: ["food"] })).toEqual(["a3", "a2"]);
    expect(ids({ text: "food crawl" })).toEqual(["a3"]);
    expect(ids({ planned: true })).toEqual(["a1"]);
    expect(ids({ planned: false })).toEqual(["a3", "a2"]);
  });

  it("finds places near a point, nearest first", () => {
    const seen = new Seen();
    const result = nearby(
      { lat: 35.69, lon: 139.7 },
      5,
      {
        activities: [
          { id: "a1", title: "Shinjuku Gyoen", cityCode: "TYO", tags: [], lat: 35.685, lon: 139.71 },
          { id: "a2", title: "Universal Studios", cityCode: "OSA", tags: [], lat: 34.66, lon: 135.43 },
          { id: "a3", title: "No pin yet", cityCode: "TYO", tags: [] },
        ] as unknown as LibraryActivity[],
        hotels: [{ id: "h1", name: "Hotel Gracery", cityCode: "TYO", areaName: "Shinjuku", lat: 35.6945, lon: 139.7016 }] as unknown as Hotel[],
        stops: view.stops,
      },
      seen,
    );
    expect(result.places.map((p) => p.id)).toEqual(["h1", "a1"]);
    expect(result.activitiesWithoutAPin).toBe(1);
    expect(seen.hotels.has("h1")).toBe(true);
    expect(seen.activities.has("a2")).toBe(false);
  });
});

describe("references", () => {
  it("passes the answer through and holds back the references, even split across chunks", () => {
    const answer = 'Two stops still need a hotel: Osaka and Kyoto.\n<refs>{"stopIds":["stop-osa"],"cityCodes":["osa"]}</refs>';
    const splitter = new RefsSplitter();
    let shown = "";
    for (let i = 0; i < answer.length; i += 3) shown += splitter.push(answer.slice(i, i + 3));
    const { tail, rawRefs } = splitter.finish();
    shown += tail;
    expect(shown).toBe("Two stops still need a hotel: Osaka and Kyoto.\n");
    expect(splitter.text).toBe(shown);
    expect(parseRefs(rawRefs)).toEqual({ stopIds: ["stop-osa"], activityIds: [], legIds: [], hotelIds: [], cityCodes: ["OSA"] });
  });

  it("lets a lone '<' through once it is clearly not a marker", () => {
    const splitter = new RefsSplitter();
    expect(splitter.push("a <")).toBe("a ");
    expect(splitter.push(" b")).toBe("< b");
    expect(splitter.push("<re")).toBe("");
    expect(splitter.finish()).toEqual({ tail: "<re", rawRefs: null });
  });

  it("treats malformed references as none", () => {
    expect(parseRefs(null).stopIds).toEqual([]);
    expect(parseRefs("{not json").legIds).toEqual([]);
    expect(parseRefs('{"stopIds":"stop-1","legIds":[1,"leg-2"]}')).toMatchObject({ stopIds: [], legIds: ["leg-2"] });
  });

  it("keeps only ids the model was shown, with labels", () => {
    const seen = new Seen();
    seen.stop("stop-osa", "Osaka (stop 2)");
    seen.city("OSA", "Osaka");
    const refs = seen.filter({ stopIds: ["stop-osa", "stop-osa", "stop-made-up"], activityIds: ["act-x"], legIds: [], hotelIds: [], cityCodes: ["OSA"] });
    expect(refs).toEqual({ stopIds: ["stop-osa"], activityIds: [], legIds: [], hotelIds: [], cityCodes: ["OSA"] });
    expect(seen.labels(refs)).toEqual([
      { kind: "stop", id: "stop-osa", label: "Osaka (stop 2)" },
      { kind: "city", id: "OSA", label: "Osaka" },
    ]);
  });

  it("lists each cited page once", () => {
    const list = dedupeCitations([
      { url: "https://a.example/visa", title: "Visa rules" },
      { url: "https://a.example/visa", title: "Visa rules", citedText: "again" },
      { url: "javascript:alert(1)", title: "bad" },
      { url: "https://b.example", title: null },
    ]);
    expect(list.map((c) => c.url)).toEqual(["https://a.example/visa", "https://b.example"]);
  });
});

describe("thread history", () => {
  const turn = (role: "user" | "assistant", text: string) => ({ role, text, at: "2026-11-19T00:00:00Z" });

  it("sends the last messages back, starting with a question and ending with an answer", () => {
    const turns = Array.from({ length: 30 }, (_, i) => turn(i % 2 ? "assistant" : "user", `m${i}`));
    const messages = historyMessages(turns, 5);
    expect(messages.map((m) => m.content)).toEqual(["m26", "m27", "m28", "m29"]);
    expect(messages[0]!.role).toBe("user");
    expect(messages.at(-1)!.role).toBe("assistant");
  });

  it("merges a question whose answer failed into the next one", () => {
    const messages = historyMessages([turn("user", "q1"), turn("assistant", ""), turn("user", "q2"), turn("assistant", "a2")]);
    expect(messages).toEqual([
      { role: "user", content: "q1\n\nq2" },
      { role: "assistant", content: "a2" },
    ]);
  });
});

describe("tools", () => {
  const ctx = { tripId: "asia-2027", seen: new Seen(), currentRouteId: "route-main", routeIds: ["route-main"], call: async () => ({}) } as unknown as ToolContext;

  it("describes every tool for the API with eager input streaming and no $schema key", () => {
    const defs = toolDefinitions();
    expect(defs.map((d) => d.name)).toEqual(["get_route", "get_itinerary", "search_activities", "get_bookings", "find_paths", "near", "compare_routes"]);
    for (const d of defs) {
      expect(d.input_schema.type).toBe("object");
      expect(d.input_schema).not.toHaveProperty("$schema");
      expect(d.eager_input_streaming).toBe(true);
    }
  });

  it("validates input before anything runs", () => {
    expect(() => prepareTool("near", { lat: 35, lon: 139, km: 500 }, ctx)).toThrow(ToolError);
    expect(() => prepareTool("find_paths", { from: "Chengdu", to: "CKG" }, ctx)).toThrow(/three letters/);
    expect(() => prepareTool("drop_tables", {}, ctx)).toThrow(/no tool called/);
    expect(prepareTool("find_paths", { from: "ctu", to: "ckg", mode: "rail" }, ctx).label).toBe("Looking for a way from CTU to CKG…");
  });

  it("refuses routes from outside the trip", async () => {
    await expect(prepareTool("get_route", { routeId: "someone-elses" }, ctx).run()).rejects.toThrow(/No route someone-elses/);
  });
});
