import type { FlightPricePoint } from "@trippr/contracts";
import { daysBetween } from "@trippr/rules";

export interface ChartBox {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ChartPoint extends FlightPricePoint {
  x: number;
  y: number;
}

export interface ChartGeometry {
  points: ChartPoint[];
  /** Axis prices, lowest first, rounded to tidy numbers. */
  yTicks: { value: number; y: number }[];
  /** A few dates along the bottom. */
  xTicks: { date: string; x: number }[];
  /** SVG path for the line (empty with fewer than two points). */
  path: string;
  min: ChartPoint | null;
  last: ChartPoint | null;
}

/** A step (1, 2, 5 times a power of ten) giving about `count` intervals over the range. */
export function niceStep(range: number, count: number): number {
  if (!(range > 0)) return 1;
  const raw = range / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/**
 * Scales price points to SVG coordinates. The x axis is real time (days
 * between snapshots, so a gap in the data shows as a gap), the y axis is
 * price from just under the lowest to just over the highest, not from zero:
 * the question is how the price moved.
 */
export function chartGeometry(data: FlightPricePoint[], box: ChartBox): ChartGeometry {
  const sorted = [...data].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
  if (!sorted.length) return { points: [], yTicks: [], xTicks: [], path: "", min: null, last: null };

  const prices = sorted.map((p) => p.priceCad);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const step = niceStep(hi - lo || hi * 0.1 || 10, 3);
  const yMin = Math.max(0, Math.floor((lo - step * 0.25) / step) * step);
  const yMax = Math.ceil((hi + step * 0.25) / step) * step;
  const first = sorted[0]!.snapshotDate;
  const span = daysBetween(first, sorted[sorted.length - 1]!.snapshotDate);
  const innerW = box.width - box.left - box.right;
  const innerH = box.height - box.top - box.bottom;
  const xOf = (date: string) => box.left + (span === 0 ? innerW / 2 : (daysBetween(first, date) / span) * innerW);
  const yOf = (price: number) => box.top + innerH - ((price - yMin) / (yMax - yMin || 1)) * innerH;

  const points = sorted.map((p) => ({ ...p, x: xOf(p.snapshotDate), y: yOf(p.priceCad) }));
  const yTicks: ChartGeometry["yTicks"] = [];
  for (let v = yMin; v <= yMax + 1e-9; v += step) yTicks.push({ value: v, y: yOf(v) });

  const xTicks: ChartGeometry["xTicks"] = [];
  const wanted = span === 0 ? 1 : Math.min(4, span + 1);
  for (let i = 0; i < wanted; i++) {
    const offset = wanted === 1 ? 0 : Math.round((i * span) / (wanted - 1));
    const date = sorted.find((p) => daysBetween(first, p.snapshotDate) >= offset)?.snapshotDate ?? first;
    if (!xTicks.some((t) => t.date === date)) xTicks.push({ date, x: xOf(date) });
  }

  const path = points.length > 1 ? points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") : "";
  const min = points.reduce((a, b) => (b.priceCad < a.priceCad ? b : a));
  return { points, yTicks, xTicks, path, min, last: points[points.length - 1]! };
}

/** The point nearest to an x position (for hover and keyboard). */
export function nearestPoint(points: ChartPoint[], x: number): ChartPoint | null {
  if (!points.length) return null;
  return points.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
}
