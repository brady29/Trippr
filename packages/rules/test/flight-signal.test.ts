import { describe, expect, it } from "vitest";
import { bookingSignal, cheapestDay, priceDrop, priceTrend, windowDates } from "../src";

/** n prices that wander between 900 and 1100, then the current price. */
const history = (n: number, current: number) => [...Array.from({ length: n }, (_, i) => 900 + ((i * 37) % 21) * 10), current];

describe("bookingSignal: not enough to say", () => {
  it("watches with low confidence and no prices", () => {
    const s = bookingSignal({ prices: [], daysToDeparture: 90 });
    expect(s).toMatchObject({ verdict: "watch", confidence: "low", samples: 0, lowerThanPct: null, lowestCad: null });
    expect(s.reason).toMatch(/No prices yet/);
  });

  it("watches while history is short, and says how many days it has", () => {
    const s = bookingSignal({ prices: [1000, 980, 990], daysToDeparture: 90 });
    expect(s).toMatchObject({ verdict: "watch", confidence: "low", samples: 3 });
    expect(s.reason).toContain("only 3 days");
  });

  it("says '1 day' in the singular", () => {
    expect(bookingSignal({ prices: [1000], daysToDeparture: 90 }).reason).toMatch(/No prices|only 1 day /);
  });

  it("needs MIN_HISTORY earlier prices (5), not 4", () => {
    expect(bookingSignal({ prices: [1100, 1100, 1100, 1100, 800], daysToDeparture: 90 }).verdict).toBe("watch");
    expect(bookingSignal({ prices: [1100, 1100, 1100, 1100, 1100, 800], daysToDeparture: 90 }).verdict).toBe("buy");
  });

  it("does not advise on a flight that has left", () => {
    const s = bookingSignal({ prices: history(10, 800), daysToDeparture: -1 });
    expect(s.verdict).toBe("watch");
    expect(s.reason).toMatch(/already left/);
  });

  it("ignores junk prices", () => {
    const s = bookingSignal({ prices: [Number.NaN, 0, -5, 1000, 1000, 1000, 1000, 1000, 700], daysToDeparture: 80 });
    expect(s.samples).toBe(6);
    expect(s.verdict).toBe("buy");
  });
});

describe("bookingSignal: cheap now", () => {
  it("says buy and quotes the percentile", () => {
    const s = bookingSignal({ prices: [...Array.from({ length: 10 }, () => 1000), 800], daysToDeparture: 100 });
    expect(s).toMatchObject({ verdict: "buy", lowerThanPct: 100, lowestCad: 800, highestCad: 1000 });
    expect(s.reason).toMatch(/Lower than 100%/);
  });

  it("buys at exactly the 75% line, not below it", () => {
    // 3 of 4 earlier prices are higher than 900 (the fourth is lower).
    const ok = bookingSignal({ prices: [1000, 1000, 1000, 850, 1000, 900], daysToDeparture: 100 });
    expect(ok.lowerThanPct).toBe(80);
    expect(ok.verdict).toBe("buy");
    const edge = bookingSignal({ prices: [1000, 1000, 1000, 850, 850, 900], daysToDeparture: 100 });
    expect(edge.lowerThanPct).toBe(60);
    expect(edge.verdict).not.toBe("buy");
  });

  it("scales confidence with the amount of history", () => {
    expect(bookingSignal({ prices: [...Array(6).fill(1000), 800], daysToDeparture: 100 }).confidence).toBe("low");
    expect(bookingSignal({ prices: [...Array(12).fill(1000), 800], daysToDeparture: 100 }).confidence).toBe("medium");
    expect(bookingSignal({ prices: [...Array(25).fill(1000), 800], daysToDeparture: 100 }).confidence).toBe("high");
  });

  it("buys when cheap even right before departure", () => {
    expect(bookingSignal({ prices: [...Array(10).fill(1000), 700], daysToDeparture: 3 }).verdict).toBe("buy");
  });
});

describe("bookingSignal: expensive now", () => {
  const expensive = (extra: number[] = []) => [...Array(10).fill(900), ...extra, 1200];

  it("waits when departure is far off", () => {
    const s = bookingSignal({ prices: expensive(), daysToDeparture: 120 });
    expect(s).toMatchObject({ verdict: "wait", lowerThanPct: 0 });
    expect(s.confidence).not.toBe("high");
    expect(s.reason).toMatch(/Higher than 100%.*120 days left/);
  });

  it("buys with low confidence, and says why, when departure is close", () => {
    const s = bookingSignal({ prices: expensive(), daysToDeparture: 14 });
    expect(s).toMatchObject({ verdict: "buy", confidence: "low" });
    expect(s.reason).toMatch(/only 14 days away/);
  });

  it("waits in the in-between window when prices are falling", () => {
    // Earlier prices 1300 down to 1000; the current 1250 is higher than few of them and the last week fell.
    const falling = [...Array(8).fill(900), 1300, 1280, 1260, 1240, 1220, 1200, 1180, 1160, 1140, 1100];
    const s = bookingSignal({ prices: [...falling, 1250], daysToDeparture: 28 });
    expect(s.lowerThanPct).toBeLessThanOrEqual(25);
    expect(s.verdict).toBe("watch");
    const withFall = [...Array(7).fill(1300), ...Array(7).fill(1000), 1000, 1000, 1250];
    expect(bookingSignal({ prices: withFall, daysToDeparture: 28 }).verdict).toBe("wait");
  });

  it("the boundaries are 21 days (close) and 35 days (far)", () => {
    expect(bookingSignal({ prices: expensive(), daysToDeparture: 21 }).verdict).toBe("buy");
    expect(bookingSignal({ prices: expensive(), daysToDeparture: 22 }).verdict).toBe("watch");
    expect(bookingSignal({ prices: expensive(), daysToDeparture: 34 }).verdict).toBe("watch");
    expect(bookingSignal({ prices: expensive(), daysToDeparture: 35 }).verdict).toBe("wait");
  });

  it("caps confidence for timing-based calls", () => {
    const long = [...Array(30).fill(900), 1200];
    expect(bookingSignal({ prices: long, daysToDeparture: 120 }).confidence).toBe("medium");
    expect(bookingSignal({ prices: long, daysToDeparture: 10 }).confidence).toBe("low");
  });
});

describe("bookingSignal: in the middle", () => {
  // Earlier prices 900..1100; the current 1000 is higher than about half of them.
  const mid = (days: number, shape: number[] = []) => ({ prices: [...shape, 900, 1100, 900, 1100, 900, 1100, 1000], daysToDeparture: days });

  it("watches when far out with a flat trend", () => {
    const s = bookingSignal(mid(90));
    expect(s.verdict).toBe("watch");
    expect(s.lowerThanPct).toBeGreaterThan(25);
    expect(s.lowerThanPct).toBeLessThan(75);
    expect(s.reason).toMatch(/middle/);
  });

  it("buys when departure is within three weeks", () => {
    const s = bookingSignal(mid(10));
    expect(s.verdict).toBe("buy");
    expect(s.reason).toMatch(/climb/);
  });

  it("waits when the last week has been falling and there is time", () => {
    const prices = [1200, 1180, 1160, 1140, 1120, 1100, 1080, 1060, 1040, 1020, 1000, 980, 960, 1100];
    const s = bookingSignal({ prices, daysToDeparture: 60 });
    expect(s.trend).toBe("falling");
    expect(s.lowerThanPct).toBeGreaterThan(25);
    expect(s.lowerThanPct).toBeLessThan(75);
    expect(s.verdict).toBe("wait");
  });

  it("buys when the price is rising and departure is within six weeks", () => {
    const prices = [900, 920, 940, 960, 980, 1000, 1020, 1040, 1060, 1080, 1100, 1120, 1140, 1150];
    // Current is the highest here, so build a middling current instead.
    const mid2 = [...prices.slice(0, 13), 1060];
    const s = bookingSignal({ prices: mid2, daysToDeparture: 40 });
    expect(s.trend).toBe("rising");
    expect(s.verdict).toBe("buy");
  });

  it("does not use trend with fewer than 10 prices", () => {
    expect(bookingSignal(mid(90)).trend).toBeNull();
  });
});

describe("bookingSignal: summary numbers", () => {
  it("reports lowest, median and highest of everything seen", () => {
    const s = bookingSignal({ prices: [1000, 1200, 800, 1000, 900, 1100], daysToDeparture: 60 });
    expect(s).toMatchObject({ lowestCad: 800, highestCad: 1200, medianCad: 1000, samples: 6, daysToDeparture: 60 });
  });

  it("is a pure function of its input", () => {
    const input = { prices: history(15, 950), daysToDeparture: 50 };
    expect(bookingSignal(input)).toEqual(bookingSignal({ ...input, prices: [...input.prices] }));
  });
});

describe("priceTrend", () => {
  it("is null without 10 prices", () => {
    expect(priceTrend(Array(9).fill(1000))).toBeNull();
  });
  it("detects falling, rising and flat", () => {
    expect(priceTrend([...Array(7).fill(1000), ...Array(7).fill(900)])).toBe("falling");
    expect(priceTrend([...Array(7).fill(1000), ...Array(7).fill(1100)])).toBe("rising");
    expect(priceTrend([...Array(7).fill(1000), ...Array(7).fill(1010)])).toBe("flat");
  });
});

describe("priceDrop", () => {
  it("flags a price 15% or more under the previous low", () => {
    expect(priceDrop(1000, 850)).toEqual({ dropped: true, pct: 15 });
    expect(priceDrop(1000, 849)).toMatchObject({ dropped: true, pct: 15.1 });
  });
  it("ignores smaller drops and rises", () => {
    expect(priceDrop(1000, 860)).toEqual({ dropped: false, pct: 14 });
    expect(priceDrop(1000, 1100)).toEqual({ dropped: false, pct: -10 });
  });
  it("has no opinion without a previous low", () => {
    expect(priceDrop(null, 500)).toEqual({ dropped: false, pct: 0 });
    expect(priceDrop(0, 500)).toEqual({ dropped: false, pct: 0 });
  });
  it("takes a custom threshold", () => {
    expect(priceDrop(1000, 940, 5).dropped).toBe(true);
    expect(priceDrop(1000, 940, 10).dropped).toBe(false);
  });
});

describe("windowDates and cheapestDay", () => {
  it("lists the planned date and three days either side", () => {
    expect(windowDates("2027-03-01", 3)).toEqual([
      "2027-02-26",
      "2027-02-27",
      "2027-02-28",
      "2027-03-01",
      "2027-03-02",
      "2027-03-03",
      "2027-03-04",
    ]);
    expect(windowDates("2027-03-01", 0)).toEqual(["2027-03-01"]);
  });

  const w = [
    { date: "2027-05-09", priceCad: 1000 },
    { date: "2027-05-10", priceCad: null },
    { date: "2027-05-11", priceCad: 900 },
    { date: "2027-05-12", priceCad: 950 },
    { date: "2027-05-13", priceCad: 900 },
  ];

  it("picks the cheapest day, earliest on a tie, and the saving against the planned day", () => {
    expect(cheapestDay(w, "2027-05-12")).toEqual({ date: "2027-05-11", priceCad: 900, savingCad: 50, isPlanned: false });
  });
  it("prefers the planned day on a tie", () => {
    expect(cheapestDay([{ date: "2027-05-11", priceCad: 900 }, { date: "2027-05-12", priceCad: 900 }], "2027-05-12")).toMatchObject({
      date: "2027-05-12",
      isPlanned: true,
      savingCad: 0,
    });
  });
  it("copes with no planned price and with no prices", () => {
    expect(cheapestDay([{ date: "2027-05-11", priceCad: 900 }], "2027-05-12")).toMatchObject({ savingCad: null, isPlanned: false });
    expect(cheapestDay([{ date: "2027-05-11", priceCad: null }], "2027-05-12")).toBeNull();
    expect(cheapestDay([], "2027-05-12")).toBeNull();
  });
});
