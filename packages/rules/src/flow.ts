import { describeNights, searchNights, type NightsChange } from "./anchors";
import { computeBudget, type BudgetStop } from "./budget";
import type { RuleLeg, RuleStop } from "./types";

/**
 * Where the money goes, as a flow: the per-person total splits into stays,
 * getting around and activities, and each of those into the cities it's
 * spent in. Booked money is marked so it can be drawn differently from
 * estimates.
 */
export interface FlowStop extends BudgetStop {
  cityName: string;
  /** The stay (or the travel into this stop) is booked, not an estimate. */
  stayBooked?: boolean;
  travelBooked?: boolean;
}

export type FlowCategory = "stay" | "travel" | "activities";
export const FLOW_LABEL: Record<FlowCategory, string> = { stay: "Stays", travel: "Getting around", activities: "Activities" };

export interface FlowLink {
  source: string;
  target: string;
  value: number;
  booked: boolean;
}

export interface Flows {
  total: number;
  nodes: { id: string; label: string; value: number; column: 0 | 1 | 2 }[];
  links: FlowLink[];
}

export function budgetFlows(stops: readonly FlowStop[]): Flows {
  const links: FlowLink[] = [];
  const cityTotals = new Map<string, { label: string; value: number }>();
  const catTotals: Record<FlowCategory, number> = { stay: 0, travel: 0, activities: 0 };
  const add = (cat: FlowCategory, s: FlowStop, value: number, booked: boolean) => {
    if (!(value > 0)) return;
    catTotals[cat] += value;
    const city = cityTotals.get(s.id) ?? { label: s.cityName, value: 0 };
    city.value += value;
    cityTotals.set(s.id, city);
    links.push({ source: cat, target: s.id, value, booked });
  };
  for (const s of stops) {
    add("stay", s, (s.stayCadPerNight ?? 0) * s.nights, Boolean(s.stayBooked));
    add("travel", s, s.arriveCostCad ?? 0, Boolean(s.travelBooked));
    add("activities", s, (s.planned ?? []).reduce((n, a) => n + (a.costCad ?? 0), 0), false);
  }
  const total = catTotals.stay + catTotals.travel + catTotals.activities;
  const cats = (Object.keys(catTotals) as FlowCategory[]).filter((c) => catTotals[c] > 0);
  return {
    total,
    nodes: [
      ...(total > 0 ? [{ id: "total", label: "Per person", value: total, column: 0 as const }] : []),
      ...cats.map((c) => ({ id: c, label: FLOW_LABEL[c], value: catTotals[c], column: 1 as const })),
      ...[...cityTotals].map(([id, c]) => ({ id, label: c.label, value: c.value, column: 2 as const })),
    ],
    links: [...cats.map((c) => ({ source: "total", target: c, value: catTotals[c], booked: false })), ...links],
  };
}

export interface SankeyNode {
  id: string;
  label: string;
  value: number;
  column: 0 | 1 | 2;
  x: number;
  y: number;
  h: number;
}

export interface SankeyBand extends FlowLink {
  path: string;
  /** Thickness in px. */
  w: number;
}

/**
 * Three columns of bars sized by money, joined by bands as wide as the money
 * flowing between them. Every column adds up to the same total, so one scale
 * fits all.
 */
export function sankeyLayout(flows: Flows, { width, height, nodeWidth = 10, gap = 8 }: { width: number; height: number; nodeWidth?: number; gap?: number }) {
  const cols = [0, 1, 2].map((c) => flows.nodes.filter((n) => n.column === c));
  const most = Math.max(1, ...cols.map((c) => c.length));
  const scale = flows.total > 0 ? Math.max(0, height - gap * (most - 1)) / flows.total : 0;
  const xs = [0, (width - nodeWidth) / 2, width - nodeWidth];
  const nodes = new Map<string, SankeyNode>();
  cols.forEach((col, c) => {
    const used = col.reduce((n, x) => n + x.value * scale, 0) + gap * Math.max(0, col.length - 1);
    let y = (height - used) / 2;
    for (const n of col) {
      const h = n.value * scale;
      nodes.set(n.id, { ...n, x: xs[c]!, y, h });
      y += h + gap;
    }
  });
  const outAt = new Map<string, number>();
  const inAt = new Map<string, number>();
  const bands: SankeyBand[] = [];
  for (const l of flows.links) {
    const s = nodes.get(l.source);
    const t = nodes.get(l.target);
    if (!s || !t) continue;
    const w = l.value * scale;
    const y0 = s.y + (outAt.get(s.id) ?? 0);
    const y1 = t.y + (inAt.get(t.id) ?? 0);
    outAt.set(s.id, (outAt.get(s.id) ?? 0) + w);
    inAt.set(t.id, (inAt.get(t.id) ?? 0) + w);
    const x0 = s.x + nodeWidth;
    const x1 = t.x;
    const xm = (x0 + x1) / 2;
    const f = (n: number) => n.toFixed(1);
    const path = `M${f(x0)},${f(y0)} C${f(xm)},${f(y0)} ${f(xm)},${f(y1)} ${f(x1)},${f(y1)} L${f(x1)},${f(y1 + w)} C${f(xm)},${f(y1 + w)} ${f(xm)},${f(y0 + w)} ${f(x0)},${f(y0 + w)} Z`;
    bands.push({ ...l, path, w });
  }
  return { nodes: [...nodes.values()], bands };
}

export interface BudgetFix {
  label: string;
  changes: NightsChange[];
  /** Per person, CAD. */
  saves: number;
}

/**
 * Ways to get the per-person total under a target by changing nights, moving
 * no booking: fewer nights somewhere, or moving nights to a cheaper city.
 */
export function overBudgetFixes<S extends RuleStop & { stayCadPerNight?: number | null; arriveCostCad?: number | null }>(
  startDate: string,
  stops: readonly S[],
  target: number,
  home: readonly RuleLeg[] = [],
): BudgetFix[] {
  // Planned activities carry their cost on the same objects the rules read.
  const total = (list: readonly S[]) => computeBudget(list as unknown as BudgetStop[]).perPerson.total;
  const before = total(stops);
  if (before <= target) return [];
  const nightly = stops.map((s) => s.stayCadPerNight ?? 0).filter((n) => n > 0);
  if (!nightly.length) return [];
  const needed = Math.ceil((before - target) / Math.max(...nightly));
  return searchNights(startDate, stops, (after) => total(after) <= target, { maxDelta: Math.min(7, Math.max(1, needed + 1)) }, home).map((o) => {
    const after = stops.map((s) => ({ ...s, nights: o.changes.find((c) => c.stopId === s.id)?.nights ?? s.nights }));
    return { label: describeNights(stops, o.changes), changes: o.changes, saves: Math.round(before - total(after)) };
  });
}
