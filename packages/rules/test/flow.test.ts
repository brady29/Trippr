import { describe, expect, it } from "vitest";
import { budgetFlows, overBudgetFixes, sankeyLayout } from "../src";

const jp = { countryIso: "JP", countryName: "Japan", visaRule: null };
const stops = [
  { id: "tyo", cityName: "Tokyo", nights: 4, stayCadPerNight: 150, arriveCostCad: 900, travelBooked: true, planned: [{ id: "a1", title: "Sumo", costCad: 40 }], ...jp },
  { id: "kyo", cityName: "Kyoto", nights: 3, stayCadPerNight: 120, arriveCostCad: 90, stayBooked: true, planned: [], ...jp },
  { id: "osa", cityName: "Osaka", nights: 2, stayCadPerNight: 60, arriveCostCad: 15, planned: [{ id: "a2", title: "Dotonbori", costCad: 25 }], ...jp },
];

describe("budgetFlows", () => {
  it("splits the total into categories and each category into cities, adding up", () => {
    const f = budgetFlows(stops);
    expect(f.total).toBe(600 + 900 + 40 + 360 + 90 + 120 + 15 + 25);
    const col = (c: number) => f.nodes.filter((n) => n.column === c).reduce((s, n) => s + n.value, 0);
    expect(col(1)).toBe(f.total);
    expect(col(2)).toBe(f.total);
    expect(f.links.find((l) => l.source === "stay" && l.target === "kyo")).toMatchObject({ value: 360, booked: true });
    expect(f.links.find((l) => l.source === "travel" && l.target === "tyo")).toMatchObject({ booked: true });
  });

  it("leaves out empty categories", () => {
    const f = budgetFlows([{ id: "a", cityName: "A", nights: 2, stayCadPerNight: 50 }]);
    expect(f.nodes.map((n) => n.id)).toEqual(["total", "stay", "a"]);
  });
});

describe("sankeyLayout", () => {
  it("sizes bars and bands by money, inside the box", () => {
    const { nodes, bands } = sankeyLayout(budgetFlows(stops), { width: 300, height: 200 });
    for (const n of nodes) {
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y + n.h).toBeLessThanOrEqual(200.01);
    }
    const total = nodes.find((n) => n.id === "total")!;
    const out = bands.filter((b) => b.source === "total").reduce((s, b) => s + b.w, 0);
    expect(out).toBeCloseTo(total.h);
    expect(bands[0]!.path).toMatch(/^M[\d.]+,[\d.]+ C/);
  });
});

describe("overBudgetFixes", () => {
  it("finds nights to cut or move to a cheaper city to get under the target", () => {
    const fixes = overBudgetFixes("2027-05-10", stops, 2000);
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes[0]!.saves).toBeGreaterThanOrEqual(150);
    expect(fixes[0]!.label).toMatch(/Tokyo|Kyoto|Osaka/);
    expect(overBudgetFixes("2027-05-10", stops, 5000)).toEqual([]);
  });
});
