import { addDays, daysBetween } from "./dates";

/** A must-do from trip setup: something on a fixed date in a city ("Aoi Matsuri, Kyoto, May 15"). */
export interface MustDo {
  cityCode: string;
  title: string;
  from: string;
  to: string;
}

export interface DraftStop {
  cityCode: string;
  nights: number;
  /** The must-dos this stop is there for. */
  mustDos: MustDo[];
}

export interface Draft {
  stops: DraftStop[];
  returnDate: string;
  /** Must-dos the draft could not fit: before the start, or after the latest return. */
  missed: MustDo[];
}

/**
 * A first route from trip setup: one stop per must-do city, in date order,
 * with nights so each stop covers its must-dos and you reach the next city the
 * day before its first one. The last stop runs to the latest return, or two
 * nights past its must-do when there is none.
 */
export function draftRoute(startDate: string, mustDos: readonly MustDo[], latestReturn?: string | null): Draft {
  const sorted = [...mustDos].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const missed = sorted.filter((m) => m.to < startDate || (latestReturn && m.from > latestReturn));
  const usable = sorted.filter((m) => !missed.includes(m));
  // Consecutive must-dos in the same city share one stop.
  const groups: { cityCode: string; from: string; to: string; mustDos: MustDo[] }[] = [];
  for (const m of usable) {
    const last = groups.at(-1);
    if (last && last.cityCode === m.cityCode) {
      last.to = m.to > last.to ? m.to : last.to;
      last.mustDos.push(m);
    } else groups.push({ cityCode: m.cityCode, from: m.from, to: m.to, mustDos: [m] });
  }
  let cursor = startDate;
  const stops: DraftStop[] = groups.map((g, i) => {
    const next = groups[i + 1];
    let depart = next ? (g.to > addDays(next.from, -1) ? g.to : addDays(next.from, -1)) : latestReturn && latestReturn > g.to ? latestReturn : addDays(g.to > cursor ? g.to : cursor, 2);
    if (depart <= cursor) depart = addDays(cursor, 1);
    const nights = daysBetween(cursor, depart);
    cursor = depart;
    return { cityCode: g.cityCode, nights, mustDos: g.mustDos };
  });
  return { stops, returnDate: cursor, missed };
}
