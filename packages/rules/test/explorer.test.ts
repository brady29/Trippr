import { describe, expect, it } from "vitest";
import { computeBudget, effectiveStopCosts, perPersonNightly, runChecks, type RuleStop } from "../src";

const stop = (id: string, cityName: string, nights: number, extra: Partial<RuleStop> = {}): RuleStop => ({
  id,
  cityName,
  nights,
  countryIso: "JP",
  countryName: "Japan",
  ...extra,
});

describe("hotel and leg costs", () => {
  it("splits a room price between the people who share it", () => {
    expect(perPersonNightly(180, "room", 2)).toBe(90);
    expect(perPersonNightly(100, "room", 3)).toBe(33.33);
    expect(perPersonNightly(70, "person", 2)).toBe(70);
    expect(perPersonNightly(null, "room", 2)).toBeNull();
    expect(perPersonNightly(120, "room", 0)).toBe(120);
  });

  it("uses a chosen or booked hotel over the stay estimate, and ignores shortlisted ones", () => {
    expect(
      effectiveStopCosts({ stayCadPerNight: 40, stays: [{ status: "shortlist", perPersonCadPerNight: 99 }] }),
    ).toMatchObject({ stayCadPerNight: 40, staySource: "estimate" });
    expect(
      effectiveStopCosts({ stayCadPerNight: 40, stays: [{ status: "chosen", perPersonCadPerNight: 75 }] }),
    ).toMatchObject({ stayCadPerNight: 75, staySource: "hotel" });
    expect(effectiveStopCosts({ stays: [{ status: "booked", perPersonCadPerNight: 60 }] }).stayCadPerNight).toBe(60);
    // A chosen hotel without a price leaves the estimate in place.
    expect(effectiveStopCosts({ stayCadPerNight: 40, stays: [{ status: "chosen", perPersonCadPerNight: null }] }).stayCadPerNight).toBe(40);
  });

  it("sums priced legs over the travel estimate", () => {
    expect(effectiveStopCosts({ arriveCostCad: 50, legs: [{ priceCad: null }] })).toMatchObject({
      arriveCostCad: 50,
      travelSource: "estimate",
    });
    expect(effectiveStopCosts({ arriveCostCad: 50, legs: [{ priceCad: 120.5 }, { priceCad: 30 }, { priceCad: null }] })).toMatchObject({
      arriveCostCad: 150.5,
      travelSource: "legs",
    });
    expect(effectiveStopCosts({})).toMatchObject({ stayCadPerNight: null, arriveCostCad: null, staySource: null, travelSource: null });
  });

  it("feeds the budget", () => {
    const costs = effectiveStopCosts({ stays: [{ status: "booked", perPersonCadPerNight: 90 }], legs: [{ priceCad: 200 }] });
    const budget = computeBudget([{ id: "a", nights: 4, ...costs }], 2);
    expect(budget.perPerson).toMatchObject({ stay: 360, travel: 200, total: 560 });
    expect(budget.group.total).toBe(1120);
  });
});

describe("leg and stay checks", () => {
  it("accepts a leg departing on the arrival day or the night before", () => {
    const result = runChecks("2027-05-10", [
      stop("tyo", "Tokyo", 4, { legs: [{ id: "l1", departAt: "2027-05-09T23:40-04:00", label: "AC 1" }] }),
      stop("bjs", "Beijing", 5, { legs: [{ id: "l2", departAt: "2027-05-14T09:00+09:00" }] }),
    ]);
    expect(result.checks.filter((c) => c.kind === "leg-day")).toHaveLength(0);
  });

  it("warns when a leg departs on another day, for example after a reorder", () => {
    const result = runChecks("2027-05-10", [
      stop("tyo", "Tokyo", 4),
      stop("bjs", "Beijing", 5, { legs: [{ id: "l2", departAt: "2027-05-20T09:00+09:00", label: "Flight NH 963" }] }),
    ]);
    const check = result.checks.find((c) => c.kind === "leg-day")!;
    expect(check).toMatchObject({ level: "warn", stopId: "bjs", legId: "l2" });
    expect(check.title).toBe("Flight NH 963 into Beijing departs May 20");
    expect(result.level).toBe("warn");
  });

  it("ignores legs without a departure time", () => {
    const result = runChecks("2027-05-10", [stop("tyo", "Tokyo", 4, { legs: [{ id: "l1", departAt: null }] })]);
    expect(result.checks.some((c) => c.kind === "leg-day")).toBe(false);
  });

  it("warns when a booked hotel's dates no longer match the stop", () => {
    const booked = { hotelId: "h1", name: "Hotel Gracery", status: "booked", arrive: "2027-05-10", depart: "2027-05-14" };
    const fine = runChecks("2027-05-10", [stop("tyo", "Tokyo", 4, { stays: [booked] })]);
    expect(fine.checks.some((c) => c.kind === "stay-dates")).toBe(false);

    const moved = runChecks("2027-05-10", [stop("tyo", "Tokyo", 5, { stays: [booked] })]);
    expect(moved.checks.find((c) => c.kind === "stay-dates")).toMatchObject({
      level: "warn",
      hotelId: "h1",
      title: "Hotel Gracery is booked for other dates",
    });

    // Shortlisted and chosen hotels have no dates to clash with.
    const chosen = runChecks("2027-05-10", [stop("tyo", "Tokyo", 5, { stays: [{ ...booked, status: "chosen" }] })]);
    expect(chosen.checks.some((c) => c.kind === "stay-dates")).toBe(false);
  });
});
