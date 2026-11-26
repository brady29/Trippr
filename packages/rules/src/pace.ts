import { distanceKm } from "./travel";

/**
 * Pace: how full a stop is. Time is counted in half-days, because that is how
 * people plan ("Fushimi Inari in the morning, Gion in the evening").
 *
 * - The arrival day gives 2 half-days if you land before noon, 1 before 5 pm,
 *   none after; 1 when the arrival time is unknown.
 * - Each full day in between gives 2.
 * - The departure day gives its morning (1).
 * - A day stop (0 nights) gives 1.
 *
 * A plan takes 1 half-day, or 2 when it's planned for more than 4 hours.
 */
export interface PaceInput {
  nights: number;
  /** When the last ticket into the stop lands: local ISO 8601. */
  arriveAt?: string | null;
  planned: { durationMin?: number | null }[];
}

export type PaceLevel = "empty" | "light" | "good" | "full" | "over";

export interface Pace {
  /** Half-days you have. */
  slots: number;
  /** Half-days the plans need. */
  used: number;
  level: PaceLevel;
  /** True when a late arrival costs the first day. */
  lateArrival: boolean;
}

function arrivalSlots(arriveAt: string | null | undefined): number {
  const hour = arriveAt ? Number(arriveAt.slice(11, 13)) : NaN;
  if (!Number.isFinite(hour)) return 1;
  return hour < 12 ? 2 : hour < 17 ? 1 : 0;
}

export function stopPace({ nights, arriveAt, planned }: PaceInput): Pace {
  const first = arrivalSlots(arriveAt);
  const slots = nights <= 0 ? Math.max(1, Math.min(first, 1)) : first + 2 * (nights - 1) + 1;
  const used = planned.reduce((n, p) => n + ((p.durationMin ?? 0) > 240 ? 2 : 1), 0);
  const level: PaceLevel = used === 0 ? "empty" : used > slots ? "over" : used >= slots * 0.8 ? "full" : used <= slots * 0.4 ? "light" : "good";
  return { slots, used, level, lateArrival: Boolean(arriveAt) && first === 0 };
}

export interface Point {
  lat: number;
  lon: number;
}

export interface Insertion {
  /** 0-based position for the new stop (stops.length is the end). */
  position: number;
  /** Extra travel the new stop adds there, in km. */
  addedKm: number;
  /** Extra travel if it went at the end instead. */
  atEndKm: number;
  /** The nearest stop already on the route, and how far. */
  nearest: { index: number; km: number } | null;
}

/** Where a new city adds the least travel: between two stops it sits near, rather than at the end. */
export function bestInsertion(route: readonly Point[], city: Point): Insertion {
  const n = route.length;
  if (n === 0) return { position: 0, addedKm: 0, atEndKm: 0, nearest: null };
  const added = (i: number) => {
    if (i === 0) return distanceKm(city, route[0]!);
    if (i === n) return distanceKm(route[n - 1]!, city);
    return distanceKm(route[i - 1]!, city) + distanceKm(city, route[i]!) - distanceKm(route[i - 1]!, route[i]!);
  };
  let best = n;
  for (let i = 0; i <= n; i++) if (added(i) < added(best) - 1e-9) best = i;
  const near = route.map((p, index) => ({ index, km: distanceKm(p, city) })).sort((a, b) => a.km - b.km)[0]!;
  return { position: best, addedKm: Math.round(added(best)), atEndKm: Math.round(added(n)), nearest: { index: near.index, km: Math.round(near.km) } };
}

/** A starting number of nights: 1 for a place close to a stop already on the route, 2 otherwise. */
export function suggestedNights(insertion: Insertion): number {
  return insertion.nearest && insertion.nearest.km < 80 ? 1 : 2;
}
