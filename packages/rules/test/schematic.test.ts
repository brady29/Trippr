import { describe, expect, it } from "vitest";
import { bestOrder, octilinearPath, roundedPath, routeKm, schematicLayout } from "../src";

const cities = {
  TYO: { id: "TYO", lat: 35.68, lon: 139.69 },
  BJS: { id: "BJS", lat: 39.9, lon: 116.4 },
  SIA: { id: "SIA", lat: 34.34, lon: 108.94 },
  CKG: { id: "CKG", lat: 29.56, lon: 106.55 },
  CAN: { id: "CAN", lat: 23.13, lon: 113.26 },
  SZX: { id: "SZX", lat: 22.54, lon: 114.06 },
  HKG: { id: "HKG", lat: 22.32, lon: 114.17 },
  HAN: { id: "HAN", lat: 21.03, lon: 105.85 },
  SGN: { id: "SGN", lat: 10.82, lon: 106.63 },
  DPS: { id: "DPS", lat: -8.65, lon: 115.22 },
};
const main = Object.values(cities);

describe("schematicLayout", () => {
  it("puts every city on a free grid point inside the box, the same way every time", () => {
    const a = schematicLayout(main, { width: 340, height: 420 });
    const b = schematicLayout(main, { width: 340, height: 420 });
    expect(a).toEqual(b);
    expect(new Set(a.map((s) => `${s.x},${s.y}`)).size).toBe(main.length);
    for (const s of a) {
      expect(s.x % 24).toBe(0);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(340);
      expect(s.y).toBeLessThanOrEqual(420);
    }
  });

  it("keeps the map's shape: Tokyo east of Beijing, Bali south of everything", () => {
    const at = Object.fromEntries(schematicLayout(main, { width: 340, height: 420 }).map((s) => [s.id, s]));
    expect(at.TYO!.x).toBeGreaterThan(at.BJS!.x);
    expect(at.DPS!.y).toBeGreaterThan(Math.max(...Object.values(at).filter((s) => s.id !== "DPS").map((s) => s.y)));
    expect(at.TYO!.label).toBe("left");
  });

  it("gives a city visited twice one station", () => {
    expect(schematicLayout([cities.TYO, cities.BJS, cities.TYO], { width: 300, height: 300 })).toHaveLength(2);
  });
});

describe("octilinearPath", () => {
  it("runs diagonally, then straight, never at odd angles", () => {
    const pts = octilinearPath({ x: 0, y: 0 }, { x: 96, y: 48 });
    expect(pts).toEqual([{ x: 0, y: 0 }, { x: 48, y: 48 }, { x: 96, y: 48 }]);
    for (let i = 1; i < pts.length; i++) {
      const angle = (Math.atan2(pts[i]!.y - pts[i - 1]!.y, pts[i]!.x - pts[i - 1]!.x) * 180) / Math.PI;
      expect(Math.abs(angle) % 45).toBe(0);
    }
    expect(octilinearPath({ x: 0, y: 0 }, { x: 0, y: 72 })).toHaveLength(2);
  });

  it("draws rounded corners", () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 48, y: 48 }, { x: 96, y: 48 }])).toMatch(/^M0,0 L.* Q48,48 .* L96,48$/);
  });
});

describe("bestOrder", () => {
  it("fixes a scrambled route and keeps the first stop first", () => {
    const scrambled = [cities.TYO, cities.HKG, cities.BJS, cities.SZX, cities.SIA, cities.CAN];
    const best = bestOrder(scrambled);
    expect(best.ids[0]).toBe("TYO");
    expect(best.km).toBeLessThan(best.currentKm * 0.8);
    expect(best.km).toBeCloseTo(routeKm(best.ids.map((id) => scrambled.find((s) => s.id === id)!)));
  });

  it("never suggests an order the caller rules out", () => {
    const scrambled = [cities.TYO, cities.HKG, cities.BJS, cities.SZX];
    // Say Hong Kong's flight is booked as the second stop.
    const best = bestOrder(scrambled, (ids) => ids[1] === "HKG");
    expect(best.ids[1]).toBe("HKG");
  });

  it("improves longer routes with 2-opt", () => {
    const long = [cities.TYO, cities.DPS, cities.BJS, cities.SGN, cities.SIA, cities.HAN, cities.CKG, cities.HKG, cities.CAN, cities.SZX];
    const best = bestOrder(long);
    expect(best.ids).toHaveLength(long.length);
    expect(new Set(best.ids).size).toBe(long.length);
    expect(best.km).toBeLessThan(best.currentKm * 0.7);
  });
});
