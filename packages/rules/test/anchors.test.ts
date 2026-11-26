import { describe, expect, it } from "vitest";
import { describeAnchors, describeNights, editImpact, fixesFor, planInsert, planNights, routeAnchors, runChecks, searchNights, type RuleLeg, type RuleStop } from "../src";

const START = "2027-05-10";
const jp = { countryIso: "JP", countryName: "Japan", visaRule: null };

/**
 * Tokyo 4, Hakone 1, Kyoto 3 (Shinkansen and ryokan booked for May 15 to 18),
 * Osaka 2, Hong Kong 3 (flight booked for May 20). Home May 23.
 */
function route(): RuleStop[] {
  return [
    { id: "tyo", cityName: "Tokyo", nights: 4, ...jp },
    { id: "hak", cityName: "Hakone", nights: 1, ...jp },
    {
      id: "kyo",
      cityName: "Kyoto",
      nights: 3,
      ...jp,
      legs: [{ id: "l-shink", label: "Shinkansen Hikari 509", status: "booked", departAt: "2027-05-15T09:03+09:00", arriveAt: "2027-05-15T11:20+09:00" }],
      stays: [{ hotelId: "h-ryo", name: "Ryokan Yachiyo", status: "booked", arrive: "2027-05-15", depart: "2027-05-18" }],
    },
    { id: "osa", cityName: "Osaka", nights: 2, ...jp },
    {
      id: "hkg",
      cityName: "Hong Kong",
      nights: 3,
      countryIso: "HK",
      countryName: "Hong Kong",
      legs: [{ id: "l-cx", label: "Flight CX 503", status: "booked", departAt: "2027-05-20T10:15+09:00", arriveAt: "2027-05-20T13:40+08:00" }],
    },
  ];
}

/** The same route with the Hong Kong flight's arrival time left out. */
function withoutArrival(stops: RuleStop[]): RuleStop[] {
  return stops.map((s) => (s.id === "hkg" ? { ...s, legs: s.legs!.map(({ arriveAt: _a, ...l }) => l) } : s));
}

describe("routeAnchors", () => {
  it("turns booked tickets and hotels into anchors and ignores ideas", () => {
    const stops = route();
    stops[0]!.legs = [{ id: "l-idea", status: "idea", departAt: "2027-05-10T08:00+09:00" }];
    const ids = routeAnchors(stops).map((a) => a.id);
    expect(ids).toEqual(["leg-l-shink", "stay-in-kyo-h-ryo", "stay-out-kyo-h-ryo", "leg-l-cx"]);
  });

  it("gives a ticket with only a departure time a two-day window for overnight journeys", () => {
    const cx = routeAnchors(withoutArrival(route())).find((a) => a.id === "leg-l-cx")!;
    expect([cx.from, cx.to]).toEqual(["2027-05-20", "2027-05-21"]);
  });

  it("treats held tickets and fixed-date events as soft anchors", () => {
    const stops = route();
    stops[0]!.legs = [{ id: "l-held", status: "held", arriveAt: "2027-05-10T07:00+09:00" }];
    stops[0]!.planned = [
      { id: "a-npb", title: "BayStars vs Giants", when: { on: "2027-05-13" } },
      { id: "a-weekly", title: "Market", when: { weekdays: [3] } },
    ];
    const soft = routeAnchors(stops).filter((a) => a.strength === "soft").map((a) => a.id);
    expect(soft).toEqual(["leg-l-held", "event-tyo-a-npb"]);
  });
});

describe("describeAnchors", () => {
  it("marks the booked stop, the boxed-in stop and the free ones", () => {
    const { locks, broken } = describeAnchors(START, route());
    expect(locks).toEqual({ tyo: "free", hak: "free", kyo: "booked", osa: "boxed", hkg: "free" });
    expect(broken).toEqual([]);
  });

  it("reports booked anchors the plan no longer keeps", () => {
    const stops = route();
    stops[0]!.nights = 5;
    const { broken } = describeAnchors(START, stops);
    expect(broken.map((a) => [a.id, a.planDate])).toEqual([
      ["leg-l-shink", "2027-05-16"],
      ["stay-in-kyo-h-ryo", "2027-05-16"],
      ["stay-out-kyo-h-ryo", "2027-05-19"],
      ["leg-l-cx", "2027-05-21"],
    ]);
  });
});

describe("planNights", () => {
  it("applies a change after the last anchor without asking", () => {
    const plan = planNights(START, route(), "hkg", 1);
    expect(plan.free).toBe(true);
    expect(plan.shift.impact.homeAfter).toBe("2027-05-24");
  });

  it("suggests taking the night from Hakone when Tokyo grows", () => {
    const plan = planNights(START, route(), "tyo", 1);
    expect(plan.free).toBe(false);
    expect(plan.shift.impact.breaks.map((a) => a.id)).toContain("stay-in-kyo-h-ryo");
    expect(plan.trades.map((t) => t.withStopId)).toEqual(["hak"]);
    expect(plan.trades[0]!.changes).toEqual([
      { stopId: "tyo", nights: 5 },
      { stopId: "hak", nights: 0 },
    ]);
    expect(plan.trades[0]!.impact.homeAfter).toBe("2027-05-23");
  });

  it("offers giving a spare night to a neighbour in the same stretch", () => {
    const plan = planNights(START, route(), "tyo", -1);
    expect(plan.trades.map((t) => t.withStopId)).toEqual(["hak"]);
  });

  it("finds no trade for a stop boxed in between two bookings", () => {
    const plan = planNights(START, route(), "osa", 1);
    expect(plan.free).toBe(false);
    expect(plan.trades).toEqual([]);
  });

  it("lets a stop absorb an overnight ticket's spare day", () => {
    // Without an arrival time, landing May 21 still keeps CX 503.
    const plan = planNights(START, withoutArrival(route()), "osa", 1);
    expect(plan.free).toBe(true);
  });

  it("never trades with a stop whose hotel is booked", () => {
    const plan = planNights(START, route(), "kyo", 1);
    expect(plan.free).toBe(false);
    expect(plan.trades).toEqual([]);
  });

  it("refuses negative nights", () => {
    const stops = route();
    expect(() => planNights(START, stops, "hak", -2)).toThrow(RangeError);
  });
});

describe("the ticket home", () => {
  const home: RuleLeg[] = [{ id: "l-home", label: "Flight AC 8", status: "booked", departAt: "2027-05-23T16:40+08:00" }];

  it("fixes the home date, so the last stop is boxed in and has to trade", () => {
    const { locks, homeFixed } = describeAnchors(START, route(), home);
    expect(homeFixed).toBe(true);
    expect(locks.hkg).toBe("boxed");
    const plan = planNights(START, route(), "hkg", 1, home);
    expect(plan.free).toBe(false);
    expect(plan.trades).toEqual([]);
  });

  it("gives an arrival-only ticket home a day's slack for an overnight flight", () => {
    const anchors = routeAnchors(route(), [{ id: "l-home", status: "booked", arriveAt: "2027-05-24T06:10-07:00" }]);
    const h = anchors.find((a) => a.kind === "home")!;
    expect([h.from, h.to]).toEqual(["2027-05-23", "2027-05-24"]);
  });

  it("warns when the ticket home leaves on another day", () => {
    const stops = route();
    const checks = runChecks(START, stops.map((s) => (s.id === "hkg" ? { ...s, nights: 4 } : s)), home).checks;
    expect(checks.find((c) => c.kind === "home-day")).toMatchObject({ level: "warn", legId: "l-home" });
    expect(runChecks(START, stops, home).checks.some((c) => c.kind === "home-day")).toBe(false);
  });

  it("ignores ideas for the trip home", () => {
    expect(describeAnchors(START, route(), [{ id: "x", status: "idea", departAt: "2027-05-23T10:00+08:00" }]).homeFixed).toBe(false);
  });
});

describe("searchNights and fixesFor", () => {
  it("fits the plan to a hotel booked a day later without moving the other bookings", () => {
    const stops = route();
    // The ryokan was actually booked May 16 to 19; the Shinkansen still says May 15, so drop it for this case.
    stops[2] = { ...stops[2]!, legs: [], stays: [{ hotelId: "h-ryo", name: "Ryokan Yachiyo", status: "booked", arrive: "2027-05-16", depart: "2027-05-19" }] };
    const check = runChecks(START, stops).checks.find((c) => c.kind === "stay-dates")!;
    const fixes = fixesFor(START, stops, check);
    expect(fixes.length).toBeGreaterThan(0);
    // Tokyo or Hakone gains a night and Osaka gives one up, so CX 503 on May 20 still holds.
    expect(fixes[0]!.changes.map((c) => c.stopId).sort()).toEqual(["hak", "osa"]);
    expect(fixes[0]!.impact.breaks).toEqual([]);
    expect(fixes[0]!.impact.fixes.map((a) => a.id)).toEqual(["stay-in-kyo-h-ryo", "stay-out-kyo-h-ryo"]);
    expect(fixes[0]!.label).toBe("Move a night from Osaka to Hakone");
  });

  it("starts from the booked length when a hotel is booked for more nights", () => {
    const stops = route();
    stops[2] = { ...stops[2]!, legs: [], stays: [{ hotelId: "h-ryo", name: "Ryokan Yachiyo", status: "booked", arrive: "2027-05-15", depart: "2027-05-19" }] };
    const check = runChecks(START, stops).checks.find((c) => c.kind === "stay-dates")!;
    const [best] = fixesFor(START, stops, check);
    expect(best!.changes).toEqual(expect.arrayContaining([{ stopId: "kyo", nights: 4 }, { stopId: "osa", nights: 1 }]));
  });

  it("brings a China entry back under the visa-free limit", () => {
    const cn = { countryIso: "CN", countryName: "China", visaRule: { visaFreeDays: 10 } };
    const stops: RuleStop[] = [
      { id: "tyo", cityName: "Tokyo", nights: 4, ...jp },
      { id: "bjs", cityName: "Beijing", nights: 6, ...cn },
      { id: "sia", cityName: "Xi'an", nights: 5, ...cn },
      { id: "hkg", cityName: "Hong Kong", nights: 3, countryIso: "HK", countryName: "Hong Kong" },
    ];
    const check = runChecks(START, stops).checks.find((c) => c.kind === "visa-days" && c.level === "error")!;
    const fixes = fixesFor(START, stops, check);
    // 12 days on the ground against 10: two nights have to go from China.
    expect(fixes[0]!.label).toMatch(/^(Take 2 nights from (Beijing|Xi'an)|Move 2 nights from (Beijing|Xi'an) to (Tokyo|Hong Kong))$/);
    for (const f of fixes) expect(runChecks(START, stops.map((s) => ({ ...s, nights: f.changes.find((c) => c.stopId === s.id)?.nights ?? s.nights }))).checks.some((c) => c.kind === "visa-days" && c.level === "error")).toBe(false);
  });

  it("finds nothing it cannot do without moving a booking", () => {
    const stops = route();
    const options = searchNights(START, stops, (after) => after.find((s) => s.id === "kyo")!.nights === 5, { maxDelta: 2 });
    expect(options).toEqual([]);
  });

  it("says a change in words", () => {
    const stops = route();
    expect(describeNights(stops, [{ stopId: "tyo", nights: 2 }])).toBe("Take 2 nights from Tokyo");
    expect(describeNights(stops, [{ stopId: "hkg", nights: 4 }])).toBe("Add a night in Hong Kong");
  });
});

describe("planInsert", () => {
  const nara: RuleStop = { id: "new", cityName: "Nara", nights: 1, ...jp };

  it("adding a stop after the last booking moves nothing booked", () => {
    const plan = planInsert(START, route(), { ...nara, cityName: "Macau" }, 5);
    expect(plan.impact.breaks).toEqual([]);
    expect(plan.impact.homeAfter).toBe("2027-05-24");
  });

  it("adding Nara before the Hong Kong flight offers to take the night from Osaka", () => {
    const plan = planInsert(START, route(), nara, 4);
    expect(plan.impact.breaks.map((a) => a.id)).toEqual(["leg-l-cx"]);
    expect(plan.trades[0]).toMatchObject({ withStopId: "osa", changes: [{ stopId: "osa", nights: 1 }] });
    expect(plan.trades[0]!.impact.breaks).toEqual([]);
  });
});

describe("editImpact", () => {
  it("flags the bookings a reorder would move", () => {
    const stops = route();
    const swapped = [stops[0]!, stops[1]!, stops[3]!, stops[2]!, stops[4]!];
    const impact = editImpact(START, stops, swapped);
    expect(impact.breaks.map((a) => a.id)).toEqual(["leg-l-shink", "stay-in-kyo-h-ryo", "stay-out-kyo-h-ryo"]);
  });

  it("drops the anchors of a removed stop and reports what moves", () => {
    const stops = route();
    const impact = editImpact(START, stops, stops.filter((s) => s.id !== "hak"));
    expect(impact.breaks.map((a) => a.id)).toEqual(["leg-l-shink", "stay-in-kyo-h-ryo", "stay-out-kyo-h-ryo", "leg-l-cx"]);
    expect(impact.homeAfter).toBe("2027-05-22");
  });

  it("counts a booked flight home against the home date", () => {
    const home: RuleLeg[] = [{ id: "l-home", label: "Flight AC 8", status: "booked", departAt: "2027-05-23T16:40+08:00" }];
    const stops = route();
    expect(editImpact(START, stops, stops.map((s) => (s.id === "hkg" ? { ...s, nights: 4 } : s)), home).breaks.map((a) => a.id)).toEqual(["home-l-home"]);
  });

  it("notices when an edit puts a booking back on its date", () => {
    const stops = route();
    stops[0]!.nights = 5;
    const fixed = stops.map((s) => (s.id === "tyo" ? { ...s, nights: 4 } : s));
    expect(editImpact(START, stops, fixed).fixes).toHaveLength(4);
  });
});
