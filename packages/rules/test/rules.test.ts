import { describe, expect, it } from "vitest";
import {
  addDays,
  computeSchedule,
  countryEntries,
  daysBetween,
  eventFits,
  parseDate,
  runChecks,
  weekday,
  whenLabel,
  type RuleStop,
  type VisaRule,
} from "../src";

const CN_RULE: VisaRule = { visaFreeDays: 30, entriesUntil: "2026-12-31" };

const country = {
  JP: { countryIso: "JP", countryName: "Japan", visaRule: null },
  CN: { countryIso: "CN", countryName: "China", visaRule: CN_RULE },
  HK: { countryIso: "HK", countryName: "Hong Kong", visaRule: null },
  VN: { countryIso: "VN", countryName: "Vietnam", visaRule: null },
  ID: { countryIso: "ID", countryName: "Indonesia", visaRule: null },
} as const;

function stop(id: string, cityName: string, iso: keyof typeof country, nights: number, extra: Partial<RuleStop> = {}): RuleStop {
  return { id, cityName, nights, ...country[iso], ...extra };
}

/** The real "Main" route from the seed: 11 stops, 40 nights from 2027-05-10. */
const MAIN: RuleStop[] = [
  stop("tyo", "Tokyo", "JP", 4, {
    planned: [
      { id: "act-npb", title: "NPB BayStars vs Giants", when: { on: "2027-05-13" } },
      { id: "act-sumo", title: "Sumo May tournament", when: { from: "2027-05-09", to: "2027-05-23" } },
    ],
  }),
  stop("bjs", "Beijing", "CN", 5),
  stop("sia", "Xi'an", "CN", 3),
  stop("ckg", "Chongqing", "CN", 4),
  stop("can", "Guangzhou", "CN", 3),
  stop("szx", "Shenzhen", "CN", 4),
  stop("hkg", "Hong Kong", "HK", 3, {
    planned: [{ id: "act-happy-valley", title: "Happy Valley races", when: { weekdays: [3] } }],
  }),
  stop("han", "Hanoi", "VN", 4),
  stop("sgn", "Ho Chi Minh City", "VN", 3),
  stop("kom", "Komodo", "ID", 3),
  stop("dps", "Bali", "ID", 4),
];

describe("dates", () => {
  it("adds days across month and year ends", () => {
    expect(addDays("2027-05-30", 3)).toBe("2027-06-02");
    expect(addDays("2027-02-27", 2)).toBe("2027-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29"); // leap year
    expect(addDays("2027-12-30", 3)).toBe("2028-01-02");
  });

  it("counts days between dates", () => {
    expect(daysBetween("2027-05-10", "2027-06-19")).toBe(40);
  });

  it("rejects malformed and impossible dates", () => {
    expect(() => parseDate("2027-5-10")).toThrow(RangeError);
    expect(() => parseDate("2027-02-30")).toThrow(RangeError);
  });

  it("knows the weekday in UTC regardless of local time zone", () => {
    expect(weekday("2027-05-13")).toBe(4); // Thursday
  });
});

describe("computeSchedule", () => {
  it("computes arrival and departure dates from the trip start", () => {
    const s = computeSchedule("2027-05-10", MAIN);
    expect(s.totalNights).toBe(40);
    expect(s.returnDate).toBe("2027-06-19");
    expect(s.stops[0]).toMatchObject({ arrive: "2027-05-10", depart: "2027-05-14" });
    expect(s.stops[5]).toMatchObject({ arrive: "2027-05-29", depart: "2027-06-02" }); // Shenzhen crosses May→June
  });

  it("recomputes every later date when stops are reordered", () => {
    const [tokyo, beijing, xian, chongqing, ...rest] = MAIN;
    const moved = [tokyo!, chongqing!, beijing!, xian!, ...rest];
    const s = computeSchedule("2027-05-10", moved);
    expect(s.stops[1]).toMatchObject({ stop: { id: "ckg" }, arrive: "2027-05-14", depart: "2027-05-18" });
    expect(s.returnDate).toBe("2027-06-19");
  });

  it("rejects negative or fractional nights", () => {
    expect(() => computeSchedule("2027-05-10", [stop("x", "X", "JP", -1)])).toThrow(RangeError);
    expect(() => computeSchedule("2027-05-10", [stop("x", "X", "JP", 1.5)])).toThrow(RangeError);
  });

  it("handles an empty route", () => {
    const s = computeSchedule("2027-05-10", []);
    expect(s).toMatchObject({ totalNights: 0, returnDate: "2027-05-10", stops: [] });
  });
});

describe("China entries", () => {
  it("treats consecutive China stops as one 20-day entry on the Main route", () => {
    const result = runChecks("2027-05-10", MAIN);
    const china = result.visa.find((v) => v.countryIso === "CN")!;
    expect(china.entries).toHaveLength(1);
    expect(china.entries[0]).toMatchObject({
      arrive: "2027-05-14",
      depart: "2027-06-02",
      nights: 19,
      days: 20,
      overLimit: false,
    });
  });

  it("splits entries when Hong Kong sits between two China stops", () => {
    const route = [
      stop("a", "Shenzhen", "CN", 3),
      stop("b", "Hong Kong", "HK", 2),
      stop("c", "Guangzhou", "CN", 2),
    ];
    const entries = countryEntries(computeSchedule("2027-05-10", route)).filter((e) => e.countryIso === "CN");
    expect(entries.map((e) => e.days)).toEqual([4, 3]);

    const result = runChecks("2027-05-10", route);
    expect(result.checks.find((c) => c.kind === "visa-entries")).toMatchObject({ level: "warn", title: "2 entries into China" });
  });

  it("flags a 31-day entry against the 30-day limit", () => {
    const result = runChecks("2027-05-10", [stop("a", "Beijing", "CN", 15), stop("b", "Shanghai", "CN", 15)]);
    const check = result.checks.find((c) => c.kind === "visa-days")!;
    expect(check.level).toBe("error");
    expect(check.title).toBe("China entry 1: 31 of 30 days");
    expect(check.detail).toContain("1 day over");
    expect(result.level).toBe("error");
  });

  it("accepts exactly 30 days", () => {
    const result = runChecks("2027-05-10", [stop("a", "Beijing", "CN", 29)]);
    expect(result.checks.find((c) => c.kind === "visa-days")!.level).toBe("ok");
  });

  it("warns when the trip enters after the visa-free policy end date", () => {
    const result = runChecks("2027-05-10", MAIN);
    const policy = result.checks.find((c) => c.kind === "visa-policy");
    expect(policy).toMatchObject({ level: "warn" });
    expect(policy!.detail).toContain("2026-12-31");
  });

  it("does not warn about the policy when the entry is before its end date", () => {
    const result = runChecks("2026-11-20", [stop("a", "Beijing", "CN", 5)]);
    expect(result.checks.some((c) => c.kind === "visa-policy")).toBe(false);
  });
});

describe("fixed-date events", () => {
  it("fits the NPB game on Thu May 13 inside Tokyo May 10 to 14", () => {
    const result = runChecks("2027-05-10", MAIN);
    expect(result.events.find((e) => e.activityId === "act-npb")).toMatchObject({
      fits: true,
      stopArrive: "2027-05-10",
      stopDepart: "2027-05-14",
      whenLabel: "Thu May 13",
    });
  });

  it("counts an event on the arrival day and on the departure day", () => {
    expect(eventFits({ on: "2027-05-10" }, "2027-05-10", "2027-05-14")).toBe(true);
    expect(eventFits({ on: "2027-05-14" }, "2027-05-10", "2027-05-14")).toBe(true);
    expect(eventFits({ on: "2027-05-15" }, "2027-05-10", "2027-05-14")).toBe(false);
  });

  it("matches date windows that overlap the stop", () => {
    expect(eventFits({ from: "2027-05-09", to: "2027-05-23" }, "2027-05-10", "2027-05-14")).toBe(true);
    expect(eventFits({ from: "2027-05-15", to: "2027-05-23" }, "2027-05-10", "2027-05-14")).toBe(false);
  });

  it("matches recurring weekdays (Happy Valley races on Wednesdays)", () => {
    // Hong Kong on the Main route: Wed Jun 2 to Sat Jun 5.
    expect(eventFits({ weekdays: [3] }, "2027-06-02", "2027-06-05")).toBe(true);
    expect(eventFits({ weekdays: [3] }, "2027-06-03", "2027-06-05")).toBe(false);
    expect(whenLabel({ weekdays: [3] })).toBe("Every Wed");
  });

  it("flags a planned event that moves outside its stop after a reorder", () => {
    const [tokyo, beijing, ...rest] = MAIN;
    const result = runChecks("2027-05-10", [beijing!, tokyo!, ...rest]);
    const npb = result.checks.find((c) => c.activityId === "act-npb")!;
    expect(npb.level).toBe("error");
    expect(npb.title).toContain("outside your dates");
  });

  it("ignores planned activities without a fixed date", () => {
    const result = runChecks("2027-05-10", [stop("a", "Tokyo", "JP", 2, { planned: [{ id: "x", title: "Ramen", when: null }] })]);
    expect(result.events).toHaveLength(0);
  });
});

describe("runChecks summary", () => {
  it("reports total nights and the return date", () => {
    const result = runChecks("2027-05-10", MAIN);
    expect(result.checks.find((c) => c.kind === "total-nights")!.title).toBe("40 nights");
    expect(result.checks.find((c) => c.kind === "return-date")!.title).toBe("Home Jun 19");
    // The only non-ok item on Main is the policy end-date warning.
    expect(result.level).toBe("warn");
  });
});
