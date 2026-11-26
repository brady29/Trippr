import type { AssistantProposal, AssistantTurn, Hub, RouteView } from "@trippr/contracts";
import { describe, expect, it } from "vitest";
import { historyMessages, withSuggestions } from "../src/services/assistant/helpers";
import {
  advanceVersions,
  checkProposal,
  describeAddStop,
  describeLeg,
  describeNights,
  describePlace,
  describePlan,
  findProposal,
  hubKey,
  markStale,
  openRouteIds,
  parseProposeInput,
  proposeToolDefinition,
  updateProposal,
  type ProposalFacts,
} from "../src/services/assistant/proposals";

// Pure helpers only: no database, so this file also runs without Docker
// (pnpm --filter @trippr/api exec vitest run test/assistant-proposals-unit.test.ts).

const tokyo = { code: "TYO", name: "Tokyo", lat: 35.68, lon: 139.76, countryIso: "JP", countryName: "Japan", tz: "Asia/Tokyo" };
const osaka = { code: "OSA", name: "Osaka", lat: 34.69, lon: 135.5, countryIso: "JP", countryName: "Japan", tz: "Asia/Tokyo" };

const view = {
  route: { id: "route-main", tripId: "asia-2027", name: "Main", tags: [], isCurrent: true, version: 7, createdAt: "2026-01-01" },
  trip: { id: "asia-2027", name: "Asia 2027", startDate: "2027-05-09", travellers: 2 },
  role: "editor",
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
      planned: [{ id: "act-sky", title: "Shibuya Sky", day: 2, startTime: "18:30", durationMin: 90 }],
      legs: [],
      stays: [],
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
      legs: [
        {
          id: "leg-1",
          seq: 0,
          mode: "hsr",
          from: { kind: "station", id: "stn-tokyo", name: "Tokyo" },
          to: { kind: "station", id: "stn-shin-osaka", name: "Shin-Osaka" },
          number: "Nozomi 1",
          departAt: "2027-05-13T08:00+09:00",
          status: "idea",
        },
      ],
      stays: [],
    },
  ],
  checks: { level: "ok", totalNights: 7, returnDate: "2027-05-16", checks: [], visa: [], events: [] },
  plannedCostCad: 0,
  budget: { travellers: 2, perPerson: { stay: 0, travel: 0, activities: 0, total: 0 }, group: { stay: 0, travel: 0, activities: 0, total: 0 }, missing: {} },
} as unknown as RouteView;

const hub = (id: string, kind: Hub["kind"], name: string, cityCode: string): Hub => ({ id, kind, name, cityCode, cityName: cityCode, lat: 0, lon: 0 });

const facts: ProposalFacts = {
  view,
  activities: [
    { id: "act-sky", title: "Shibuya Sky", cityCode: "TYO", cityName: "Tokyo" },
    { id: "act-teamlab", title: "teamLab Planets", cityCode: "TYO", cityName: "Tokyo" },
    { id: "act-dotonbori", title: "Dotonbori at night", cityCode: "OSA", cityName: "Osaka" },
  ],
  cities: new Map([
    ["TYO", { code: "TYO", name: "Tokyo" }],
    ["OSA", { code: "OSA", name: "Osaka" }],
    ["KYO", { code: "KYO", name: "Kyoto" }],
  ]),
  hubs: new Map([
    ["hub:stn-tokyo", hub("stn-tokyo", "station", "Tokyo", "TYO")],
    ["city:OSA:station", hub("stn-shin-osaka", "station", "Shin-Osaka", "OSA")],
    ["city:TYO:airport", hub("HND", "airport", "Tokyo Haneda", "TYO")],
    ["hub:KIX", hub("KIX", "airport", "Kansai", "OSA")],
  ]),
};

const check = (p: unknown) => {
  const parsed = parseProposeInput({ proposals: [p] });
  if ("error" in parsed) throw new Error(parsed.error);
  if (parsed.dropped.length) return { reason: parsed.dropped[0]!.reason };
  return checkProposal(parsed.items[0]!.proposal, facts);
};

describe("propose_changes input", () => {
  it("validates each suggestion on its own and says why one was dropped", () => {
    const parsed = parseProposeInput({
      proposals: [
        { kind: "set_nights", stopId: "stop-tyo", nights: 5 },
        { kind: "set_nights", stopId: "stop-tyo", nights: -1 },
        { kind: "delete_everything" },
        { kind: "plan_activity", stopId: "stop-tyo", activityId: "act-teamlab", startTime: "25:00" },
      ],
    });
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.items.map((i) => i.n)).toEqual([1]);
    expect(parsed.dropped.map((d) => [d.n, d.kind])).toEqual([
      [2, "set_nights"],
      [3, "delete_everything"],
      [4, "plan_activity"],
    ]);
    expect(parsed.dropped[0]!.reason).toMatch(/nights/);
    expect(parsed.dropped[2]!.reason).toMatch(/24-hour time/);
  });

  it("keeps at most the room left in this answer", () => {
    const five = Array.from({ length: 7 }, (_, i) => ({ kind: "set_nights", stopId: "stop-tyo", nights: i + 1 }));
    const parsed = parseProposeInput({ proposals: five }, 3);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.items).toHaveLength(3);
    expect(parsed.dropped).toHaveLength(4);
    expect(parsed.dropped[0]!.reason).toMatch(/limit of 5 suggestions/);
  });

  it("refuses input without a list", () => {
    expect(parseProposeInput({})).toHaveProperty("error");
    expect(parseProposeInput({ proposals: [] })).toHaveProperty("error");
    expect(parseProposeInput(null)).toHaveProperty("error");
  });

  it("is described to the model with each kind and a limit of 5", () => {
    const def = proposeToolDefinition();
    expect(def.name).toBe("propose_changes");
    expect(def.input_schema).not.toHaveProperty("$schema");
    const proposals = (def.input_schema.properties as Record<string, { maxItems?: number }>).proposals!;
    expect(proposals.maxItems).toBe(5);
    const text = JSON.stringify(def.input_schema);
    for (const kind of ["add_activity", "plan_activity", "set_nights", "add_stop", "add_leg"]) expect(text).toContain(kind);
  });
});

describe("checking suggestions against the route", () => {
  it("changes nights, with the words on the card", () => {
    expect(check({ kind: "set_nights", stopId: "stop-tyo", nights: 5 })).toEqual({
      kind: "set_nights",
      change: { kind: "set_nights", stopId: "stop-tyo", nights: 5 },
      summary: "Tokyo: 4 → 5 nights",
      routeId: "route-main",
      version: 7,
    });
    expect(check({ kind: "set_nights", stopId: "stop-tyo", nights: 4 })).toEqual({ reason: "Tokyo already has 4 nights." });
    expect(check({ kind: "set_nights", stopId: "stop-nope", nights: 2 })).toEqual({ reason: 'There is no stop stop-nope on the route "Main" (route-main).' });
  });

  it("protects a booked ticket's date unless the member asked to move it", () => {
    const booked = {
      ...view,
      stops: view.stops.map((s) =>
        s.id === "stop-osa" ? { ...s, legs: s.legs.map((l) => ({ ...l, status: "booked" as const, arriveAt: "2027-05-13T10:30+09:00" })) } : s,
      ),
    } as RouteView;
    const checkOn = (p: unknown) => {
      const parsed = parseProposeInput({ proposals: [p] });
      if ("error" in parsed) throw new Error(parsed.error);
      return checkProposal(parsed.items[0]!.proposal, { ...facts, view: booked });
    };
    const refused = checkOn({ kind: "set_nights", stopId: "stop-tyo", nights: 5 });
    expect(refused).toHaveProperty("reason");
    expect((refused as { reason: string }).reason).toContain("Nozomi 1 off its booked dates");
    expect((refused as { reason: string }).reason).toContain("moveBookings: true");
    expect(checkOn({ kind: "set_nights", stopId: "stop-tyo", nights: 5, moveBookings: true })).toMatchObject({
      summary: "Tokyo: 4 → 5 nights (moves High-speed train Nozomi 1 off its booked dates)",
    });
    // Osaka comes after the booking, so its nights are free.
    expect(checkOn({ kind: "set_nights", stopId: "stop-osa", nights: 4 })).toMatchObject({ summary: "Osaka: 3 → 4 nights" });
    // A new stop before the booking is refused the same way.
    expect((checkOn({ kind: "add_stop", cityCode: "KYO", afterStopId: "stop-tyo", nights: 2 }) as { reason: string }).reason).toContain("off its booked dates");
  });

  it("plans an activity on a day of the trip, and only in its own city", () => {
    const planned = check({ kind: "plan_activity", stopId: "stop-tyo", activityId: "act-teamlab", day: 3, startTime: "18:30" });
    expect(planned).toMatchObject({
      change: { kind: "plan_activity", stopId: "stop-tyo", activityId: "act-teamlab", day: 3, startTime: "18:30" },
      routeId: "route-main",
      version: 7,
    });
    expect((planned as { summary: string }).summary).toMatch(/^Plan teamLab Planets on Day \d+ \(Tue May 11\) at 18:30$/);
    expect(check({ kind: "plan_activity", stopId: "stop-osa", activityId: "act-teamlab" })).toMatchObject({ reason: expect.stringMatching(/is in Tokyo, but stop stop-osa is Osaka/) });
    expect(check({ kind: "plan_activity", stopId: "stop-tyo", activityId: "act-teamlab", day: 9 })).toMatchObject({ reason: expect.stringMatching(/day must be 1 to 4/) });
    expect(check({ kind: "plan_activity", stopId: "stop-tyo", activityId: "act-made-up" })).toEqual({ reason: "There is no activity act-made-up in this trip." });
    // Already planned like that: nothing to do. A new time moves it.
    expect(check({ kind: "plan_activity", stopId: "stop-tyo", activityId: "act-sky", day: 2 })).toMatchObject({ reason: expect.stringMatching(/already planned/) });
    expect(check({ kind: "plan_activity", stopId: "stop-tyo", activityId: "act-sky", startTime: "19:00" })).toMatchObject({ summary: "Move Shibuya Sky in Tokyo at 19:00" });
  });

  it("adds a stop after another one or at the end", () => {
    expect(check({ kind: "add_stop", cityCode: "kyo", afterStopId: "stop-tyo", nights: 2 })).toMatchObject({
      change: { kind: "add_stop", cityCode: "KYO", afterStopId: "stop-tyo", nights: 2 },
      summary: "Add Kyoto for 2 nights after Tokyo",
    });
    expect(check({ kind: "add_stop", cityCode: "KYO", nights: 1 })).toMatchObject({ summary: "Add Kyoto for 1 night at the end of the route" });
    expect(check({ kind: "add_stop", cityCode: "XXX", nights: 1 })).toEqual({ reason: "There is no city XXX." });
    expect(check({ kind: "add_stop", cityCode: "KYO", afterStopId: "stop-gone", nights: 1 })).toMatchObject({ reason: expect.stringMatching(/no stop stop-gone/) });
  });

  it("adds a new idea to a city's library, not to a route", () => {
    expect(check({ kind: "add_activity", cityCode: "OSA", title: "Kuromon Market", tags: ["Food", "bad!tag"], url: "https://example.com/kuromon" })).toEqual({
      kind: "add_activity",
      change: { kind: "add_activity", cityCode: "OSA", title: "Kuromon Market", tags: ["food"], note: null, url: "https://example.com/kuromon" },
      summary: `Add "Kuromon Market" to Osaka's ideas`,
      routeId: null,
      version: null,
    });
    expect(check({ kind: "add_activity", cityCode: "TYO", title: "TEAMLAB planets" })).toMatchObject({ reason: expect.stringMatching(/already an idea in Tokyo \(activity id act-teamlab\)/) });
    expect(check({ kind: "add_activity", cityCode: "TYO", title: "Somewhere", url: "javascript:alert(1)" })).toEqual({ reason: "url must be a public https link." });
  });

  it("adds a travel idea between hubs, from a hub id or a city", () => {
    const leg = check({
      kind: "add_leg",
      stopId: "stop-osa",
      mode: "hsr",
      from: { hubId: "stn-tokyo" },
      to: { cityCode: "OSA" },
      number: "Hikari 501",
      departAt: "2027-05-13T09:00+09:00",
    });
    expect(leg).toMatchObject({
      change: {
        kind: "add_leg",
        stopId: "stop-osa",
        mode: "hsr",
        from: { kind: "station", id: "stn-tokyo" },
        to: { kind: "station", id: "stn-shin-osaka" },
        number: "Hikari 501",
        status: "idea",
      },
      summary: "Add a high-speed train idea to Osaka: Tokyo → Shin-Osaka (Hikari 501, Thu May 13 09:00)",
      version: 7,
    });
    expect(check({ kind: "add_leg", stopId: "stop-osa", mode: "hsr", from: { hubId: "stn-tokyo" }, to: { cityCode: "OSA" }, number: "Nozomi 1", departAt: "2027-05-13T10:00+09:00" })).toMatchObject({
      reason: "Nozomi 1 is already on the way to Osaka.",
    });
    expect(check({ kind: "add_leg", stopId: "stop-osa", mode: "flight", from: { cityCode: "TYO" }, to: { hubId: "KIX" } })).toMatchObject({ summary: "Add a flight idea to Osaka: Tokyo Haneda → Kansai" });
    expect(check({ kind: "add_leg", stopId: "stop-osa", mode: "flight", from: { hubId: "stn-tokyo" }, to: { hubId: "KIX" } })).toMatchObject({ reason: expect.stringMatching(/a station; a flight needs airports/) });
    expect(check({ kind: "add_leg", stopId: "stop-osa", mode: "hsr", from: { hubId: "stn-tokyo", cityCode: "TYO" }, to: { cityCode: "OSA" } })).toMatchObject({ reason: expect.stringMatching(/exactly one of hubId or cityCode/) });
    expect(check({ kind: "add_leg", stopId: "stop-osa", mode: "hsr", from: { cityCode: "KYO" }, to: { cityCode: "OSA" } })).toMatchObject({ reason: expect.stringMatching(/No station is known in KYO/) });
    expect(check({ kind: "add_leg", stopId: "stop-osa", mode: "hsr", from: { hubId: "stn-tokyo" }, to: { cityCode: "OSA" }, status: "booked" })).toMatchObject({ reason: expect.stringMatching(/status/) });
  });

  it("keys hubs by id, or by city and the kind the mode needs", () => {
    expect(hubKey({ hubId: "KIX" }, "flight")).toBe("hub:KIX");
    expect(hubKey({ cityCode: "osa" }, "flight")).toBe("city:OSA:airport");
    expect(hubKey({ cityCode: "OSA" }, "train")).toBe("city:OSA:station");
  });
});

describe("words on the cards", () => {
  it("reads like a change, not a request", () => {
    expect(describeNights("Tokyo", 4, 5)).toBe("Tokyo: 4 → 5 nights");
    expect(describeNights("Hue", 2, 1)).toBe("Hue: 2 → 1 night");
    expect(describePlan({ title: "Shibuya Sky", cityName: "Tokyo", moving: false, dayIndex: 3, date: "2027-05-11", stopDay: 3, startTime: "18:30" })).toBe(
      "Plan Shibuya Sky on Day 3 (Tue May 11) at 18:30",
    );
    expect(describePlan({ title: "Shibuya Sky", cityName: "Tokyo", moving: false, dayIndex: null, date: null, durationMin: 90 })).toBe("Plan Shibuya Sky in Tokyo for 90 min");
    expect(describeAddStop("Kyoto", 2, null)).toBe("Add Kyoto for 2 nights at the end of the route");
    expect(describeLeg({ mode: "train", cityName: "Hue", from: "Hanoi", to: "Hue", number: null, departAt: null })).toBe("Add a train idea to Hue: Hanoi → Hue");
  });

  it("says what the place lookup found", () => {
    expect(describePlace(null)).toBeNull();
    expect(describePlace({ placeStatus: null })).toBeNull();
    expect(describePlace({ website: "https://a.example", ticketUrl: "https://b.example", placeStatus: "placed" })).toBe("Found website, tickets; pin on the map.");
    expect(describePlace({ placeStatus: "check" })).toBe("A pin to check.");
    expect(describePlace({ reserveUrl: "https://r.example", placeStatus: "not_found" })).toBe("Found reservations; not found on the map.");
  });
});

const proposal = (over: Partial<AssistantProposal>): AssistantProposal => ({
  id: "prop-1",
  kind: "set_nights",
  routeId: "route-main",
  version: 7,
  summary: "Tokyo: 4 → 5 nights",
  status: "open",
  change: { kind: "set_nights", stopId: "stop-tyo", nights: 5 },
  ...over,
});

const thread = (): AssistantTurn[] => [
  { role: "user", text: "More time in Tokyo?", at: "t1" },
  {
    role: "assistant",
    text: "Sure, here's how.",
    at: "t1",
    proposals: [
      proposal({}),
      proposal({ id: "prop-2", summary: "Add Kyoto for 2 nights after Tokyo", kind: "add_stop", change: { kind: "add_stop", cityCode: "KYO", afterStopId: "stop-tyo", nights: 2 } }),
      proposal({ id: "prop-3", kind: "add_activity", routeId: null, version: null, summary: `Add "Kuromon Market" to Osaka's ideas` }),
      proposal({ id: "prop-4", routeId: "route-alt", version: 2, status: "dismissed" }),
    ],
  },
];

describe("stored suggestions", () => {
  it("finds and updates one without touching the original", () => {
    const turns = thread();
    expect(findProposal(turns, "prop-2")?.summary).toBe("Add Kyoto for 2 nights after Tokyo");
    expect(findProposal(turns, "nope")).toBeNull();
    const next = updateProposal(turns, "prop-2", (p) => ({ ...p, status: "applied" }));
    expect(findProposal(next, "prop-2")?.status).toBe("applied");
    expect(findProposal(turns, "prop-2")?.status).toBe("open");
  });

  it("goes stale when its route's version moves on, or the route is gone", () => {
    const turns = thread();
    expect(openRouteIds(turns)).toEqual(["route-main"]);
    expect(markStale(turns, new Map([["route-main", 7]]))).toBeNull();
    const next = markStale(turns, new Map([["route-main", 8]]))!;
    expect(next[1]!.proposals!.map((p) => p.status)).toEqual(["stale", "stale", "open", "dismissed"]);
    expect(findProposal(next, "prop-1")?.note).toBe("The plan changed; ask again.");
    expect(findProposal(markStale(turns, new Map([["route-main", null]]))!, "prop-1")?.note).toBe("That route was deleted.");
  });

  it("moves sibling suggestions to the new version after one is applied", () => {
    const applied = updateProposal(thread(), "prop-1", (p) => ({ ...p, status: "applied" }));
    const next = advanceVersions(applied, "route-main", 7, 8);
    expect(findProposal(next, "prop-2")?.version).toBe(8);
    expect(findProposal(next, "prop-1")?.version).toBe(7);
    expect(findProposal(next, "prop-4")?.version).toBe(2);
    expect(advanceVersions(applied, "route-main", 7, 7)).toBe(applied);
  });

  it("tells the model on the next question what became of its suggestions", () => {
    const turns = updateProposal(thread(), "prop-1", (p) => ({ ...p, status: "applied" }));
    expect(withSuggestions(turns[1]!)).toContain(`[Suggested changes: "Tokyo: 4 → 5 nights" (applied); "Add Kyoto for 2 nights after Tokyo" (open);`);
    expect(withSuggestions(turns[0]!)).toBe("More time in Tokyo?");
    expect(historyMessages(turns)[1]!.content).toContain("(applied)");
  });
});
