import { describe, expect, it } from "vitest";
import { chartGeometry, nearestPoint, niceStep, type ChartBox } from "./price-chart";

const box: ChartBox = { width: 500, height: 200, left: 40, right: 10, top: 10, bottom: 30 };
const point = (snapshotDate: string, priceCad: number) => ({ snapshotDate, priceCad, airline: null, stops: null });

describe("niceStep", () => {
  it("rounds to 1, 2, 5 or 10 times a power of ten", () => {
    expect(niceStep(300, 3)).toBe(100);
    expect(niceStep(450, 3)).toBe(200);
    expect(niceStep(1200, 3)).toBe(500);
    expect(niceStep(0, 3)).toBe(1);
  });
});

describe("chartGeometry", () => {
  it("is empty without data", () => {
    expect(chartGeometry([], box)).toMatchObject({ points: [], path: "", min: null, last: null });
  });

  it("puts the first snapshot at the left edge and the last at the right, higher prices higher up", () => {
    const g = chartGeometry([point("2027-03-01", 1000), point("2027-03-11", 800), point("2027-03-21", 1200)], box);
    expect(g.points[0]!.x).toBe(40);
    expect(g.points[2]!.x).toBe(490);
    expect(g.points[2]!.y).toBeLessThan(g.points[0]!.y);
    expect(g.points[1]!.y).toBeGreaterThan(g.points[0]!.y);
    expect(g.points.every((p) => p.y >= box.top && p.y <= box.height - box.bottom)).toBe(true);
    expect(g.min).toMatchObject({ priceCad: 800 });
    expect(g.last).toMatchObject({ snapshotDate: "2027-03-21" });
    expect(g.path).toMatch(/^M40\.0 /);
  });

  it("spaces points by real time, so a gap in the data shows", () => {
    const g = chartGeometry([point("2027-03-01", 1000), point("2027-03-02", 1000), point("2027-03-11", 1000)], box);
    expect(g.points[1]!.x - g.points[0]!.x).toBeCloseTo((490 - 40) / 10, 5);
  });

  it("does not need the data in order", () => {
    const g = chartGeometry([point("2027-03-11", 800), point("2027-03-01", 1000)], box);
    expect(g.points.map((p) => p.snapshotDate)).toEqual(["2027-03-01", "2027-03-11"]);
  });

  it("centres a single point and draws no line", () => {
    const g = chartGeometry([point("2027-03-01", 1000)], box);
    expect(g.points[0]!.x).toBe(265);
    expect(g.path).toBe("");
    expect(g.xTicks).toHaveLength(1);
  });

  it("gives tidy y ticks that bracket the data, and never below zero", () => {
    const g = chartGeometry([point("2027-03-01", 130), point("2027-03-02", 190)], box);
    const values = g.yTicks.map((t) => t.value);
    expect(values[0]!).toBeLessThanOrEqual(130);
    expect(values.at(-1)!).toBeGreaterThanOrEqual(190);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(g.yTicks.every((t, i) => i === 0 || t.y < g.yTicks[i - 1]!.y)).toBe(true);
  });

  it("copes with a flat price", () => {
    const g = chartGeometry([point("2027-03-01", 500), point("2027-03-05", 500)], box);
    expect(g.points[0]!.y).toBe(g.points[1]!.y);
    expect(Number.isFinite(g.points[0]!.y)).toBe(true);
  });
});

describe("nearestPoint", () => {
  const g = chartGeometry([point("2027-03-01", 1000), point("2027-03-11", 800), point("2027-03-21", 1200)], box);
  it("finds the closest snapshot to a pointer position", () => {
    expect(nearestPoint(g.points, 0)!.snapshotDate).toBe("2027-03-01");
    expect(nearestPoint(g.points, 270)!.snapshotDate).toBe("2027-03-11");
    expect(nearestPoint(g.points, 9999)!.snapshotDate).toBe("2027-03-21");
    expect(nearestPoint([], 5)).toBeNull();
  });
});
