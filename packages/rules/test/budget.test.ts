import { describe, expect, it } from "vitest";
import { computeBudget, type BudgetStop } from "../src";

const stops: BudgetStop[] = [
  { id: "tyo", nights: 4, stayCadPerNight: 60, arriveCostCad: 900, planned: [{ costCad: 45 }, { costCad: 60 }] },
  { id: "bjs", nights: 5, stayCadPerNight: 40, arriveCostCad: null, planned: [{ costCad: null }, { costCad: 45 }] },
  { id: "sia", nights: 3, stayCadPerNight: null, arriveCostCad: 110, planned: [] },
];

describe("computeBudget", () => {
  it("adds stay, travel and planned activities per person", () => {
    const b = computeBudget(stops, 1);
    expect(b.perPerson).toEqual({ stay: 440, travel: 1010, activities: 150, total: 1600 });
  });

  it("multiplies by the number of travellers for the group total", () => {
    const b = computeBudget(stops, 6);
    expect(b.travellers).toBe(6);
    expect(b.group).toEqual({ stay: 2640, travel: 6060, activities: 900, total: 9600 });
  });

  it("lists missing estimates instead of guessing", () => {
    const b = computeBudget(stops, 6);
    expect(b.missing).toEqual({ stayNights: 3, travelLegs: 1, stayStopIds: ["sia"], travelStopIds: ["bjs"] });
  });

  it("does not count a zero-night stop as a missing stay", () => {
    const b = computeBudget([{ id: "x", nights: 0, stayCadPerNight: null, arriveCostCad: 20 }], 2);
    expect(b.missing.stayNights).toBe(0);
    expect(b.missing.stayStopIds).toEqual([]);
  });

  it("treats a stay of zero as an estimate (staying with friends)", () => {
    const b = computeBudget([{ id: "x", nights: 3, stayCadPerNight: 0, arriveCostCad: 0 }], 1);
    expect(b.perPerson.total).toBe(0);
    expect(b.missing).toMatchObject({ stayNights: 0, travelLegs: 0 });
  });

  it("rounds to cents and falls back to one traveller for bad input", () => {
    const b = computeBudget([{ id: "x", nights: 3, stayCadPerNight: 33.333, arriveCostCad: 0.1 }], 0);
    expect(b.travellers).toBe(1);
    expect(b.perPerson.stay).toBe(100);
    expect(b.perPerson.total).toBe(100.1);
  });

  it("is all zeros for an empty route", () => {
    expect(computeBudget([], 6).group.total).toBe(0);
  });
});
