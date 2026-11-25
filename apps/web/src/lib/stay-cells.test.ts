import type { StayCell, StayCellsResponse } from "@trippr/contracts";
import { describe, expect, it } from "vitest";
import { bboxParam, cellRing, cellsToFeatures, describeCell, legendRows, priceRatio, rampColor, snapBbox, STAY_RAMP } from "./stay-cells";

const TOKYO_CELL = "882f5aad93fffff"; // the resolution-8 cell over Shibuya

const cell = (over: Partial<StayCell> = {}): StayCell => ({ id: TOKYO_CELL, city: "TYO", lat: 35.66, lon: 139.7, price: 150, pp: 60, listings: 8, score: 55, ...over });
const response = (cells: StayCell[], scale: { low: number; high: number } | null = { low: 100, high: 200 }): Pick<StayCellsResponse, "cells" | "cities"> => ({
  cells,
  cities: [{ cityCode: "TYO", cityName: "Tokyo", snapshotDate: "2026-09-25", cityMedianCad: 137, scale }],
});

describe("the colour scale", () => {
  it("places a price between the city's low and high, clamped", () => {
    expect(priceRatio(100, { low: 100, high: 200 })).toBe(0);
    expect(priceRatio(150, { low: 100, high: 200 })).toBe(0.5);
    expect(priceRatio(300, { low: 100, high: 200 })).toBe(1);
    expect(priceRatio(10, { low: 100, high: 200 })).toBe(0);
    expect(priceRatio(150, null)).toBe(0.5);
    expect(priceRatio(150, { low: 120, high: 120 })).toBe(0.5);
  });

  it("interpolates the ramp and hits its stops exactly", () => {
    expect(rampColor(0)).toBe(STAY_RAMP[0]);
    expect(rampColor(1)).toBe(STAY_RAMP.at(-1));
    expect(rampColor(0.5)).toBe(STAY_RAMP[2]);
    expect(rampColor(-3)).toBe(STAY_RAMP[0]);
    expect(rampColor(7)).toBe(STAY_RAMP.at(-1));
    expect(rampColor(0.125)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("gets darker as it gets dearer (a monotonic sequential ramp)", () => {
    const lightness = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).reduce((a, b) => a + b, 0);
    const steps = STAY_RAMP.map(lightness);
    expect(steps).toEqual([...steps].sort((a, b) => b - a));
  });
});

describe("hexagons", () => {
  it("draws a closed six-sided ring around the cell's centre", () => {
    const ring = cellRing(TOKYO_CELL);
    expect(ring).toHaveLength(7);
    expect(ring[0]).toEqual(ring.at(-1));
    const lons = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    // GeoJSON order is [lon, lat]: Tokyo is near 139.7 E, 35.6 N.
    expect(Math.min(...lons)).toBeGreaterThan(139);
    expect(Math.max(...lats)).toBeLessThan(36);
  });

  it("turns priced cells into polygons with their ratio, and leaves out the rest", () => {
    const fc = cellsToFeatures(response([cell({ price: 150 }), cell({ id: "882f5a3213fffff", price: null }), cell({ id: "not-a-cell" })]));
    expect(fc.features).toHaveLength(1);
    const [f] = fc.features;
    expect(f!.geometry.type).toBe("Polygon");
    expect(f!.properties).toEqual({ id: TOKYO_CELL, city: "TYO", price: 150, pp: 60, listings: 8, ratio: 0.5 });
  });

  it("uses each city's own scale", () => {
    const res = {
      cells: [cell({ price: 150 }), cell({ id: "882f5a3213fffff", city: "SIN", price: 150 })],
      cities: [
        { cityCode: "TYO", cityName: "Tokyo", snapshotDate: null, cityMedianCad: null, scale: { low: 100, high: 200 } },
        { cityCode: "SIN", cityName: "Singapore", snapshotDate: null, cityMedianCad: null, scale: { low: 100, high: 400 } },
      ],
    };
    expect(cellsToFeatures(res).features.map((f) => f.properties.ratio)).toEqual([0.5, expect.closeTo(1 / 6, 5)]);
  });

  it("carries nothing that could identify a listing", () => {
    const keys = Object.keys(cellsToFeatures(response([cell()])).features[0]!.properties);
    expect(keys.sort()).toEqual(["city", "id", "listings", "pp", "price", "ratio"]);
  });
});

describe("the legend and the viewport", () => {
  it("lists a row per city with a scale", () => {
    expect(legendRows(response([cell()]))).toEqual([{ cityCode: "TYO", cityName: "Tokyo", low: 100, high: 200, snapshotDate: "2026-09-25" }]);
    expect(legendRows(response([cell()], null))).toEqual([]);
  });

  it("snaps the viewport outward to a tenth of a degree so small pans do not refetch", () => {
    const a = snapBbox([[139.612, 35.512], [139.941, 35.838]]);
    expect(a).toEqual({ minLon: 139.6, minLat: 35.5, maxLon: 140, maxLat: 35.9 });
    expect(snapBbox([[139.618, 35.519], [139.93, 35.81]])).toEqual(a);
    expect(bboxParam(a)).toBe("139.6,35.5,140.0,35.9");
    expect(snapBbox([[-200, -95], [200, 95]])).toEqual({ minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 });
  });

  it("describes a clicked cell", () => {
    expect(describeCell({ price: 149.6, pp: 60, listings: 8 })).toBe("Median CAD 150 a night (CAD 60 a person), from 8 listings");
    expect(describeCell({ price: 120, pp: null, listings: 3 })).toBe("Median CAD 120 a night, from 3 listings");
  });
});
