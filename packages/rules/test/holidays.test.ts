import { describe, expect, it } from "vitest";
import { busyPeriods } from "../src";

describe("busyPeriods", () => {
  it("finds Golden Week and China's Labour Day holiday on a May route", () => {
    const names = busyPeriods("2027-05-01", "2027-06-19", ["JP", "CN", "HK"]).map((p) => p.name);
    expect(names).toEqual(["Golden Week", "Labour Day holiday"]);
  });

  it("only returns periods in the route's countries", () => {
    expect(busyPeriods("2027-04-10", "2027-04-20", ["JP"])).toEqual([]);
    expect(busyPeriods("2027-04-10", "2027-04-20", ["TH"]).map((p) => p.name)).toEqual(["Songkran"]);
  });

  it("knows Lunar New Year moves, and New Year runs into January", () => {
    const lny = busyPeriods("2027-02-01", "2027-02-28", ["VN"])[0]!;
    expect([lny.name, lny.from, lny.to]).toEqual(["Lunar New Year", "2027-02-05", "2027-02-12"]);
    const ny = busyPeriods("2027-01-01", "2027-01-05", ["JP"])[0]!;
    expect([ny.name, ny.from, ny.to]).toEqual(["Japanese New Year", "2026-12-29", "2027-01-03"]);
  });
});
