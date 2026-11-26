import { addDays, daysBetween } from "./dates";
import { eventFits } from "./events";
import { anchorStates, describeNights, routeAnchors, searchNights, type EditImpact, type NightsChange } from "./anchors";
import { computeSchedule } from "./schedule";
import type { Check, RuleLeg, RuleStop, When } from "./types";
import { visaSummaries } from "./visa";

/** One way to make a check pass by changing nights, worked out so it moves no booking that is on its dates. */
export interface Fix {
  label: string;
  changes: NightsChange[];
  impact: EditImpact;
}

const cap = (n: number, max = 7) => Math.max(1, Math.min(max, Math.abs(n)));

/**
 * Fixes for one check, best first (at most three). Only checks that a nights
 * change can fix get any: visa days over the limit, a fixed-date event outside
 * its stop, and a ticket or hotel whose dates no longer match the plan.
 */
export function fixesFor<S extends RuleStop>(
  startDate: string,
  stops: readonly S[],
  check: Check,
  home: readonly RuleLeg[] = [],
  latestReturn?: string | null,
): Fix[] {
  const goal = goalFor(startDate, stops, check, home, latestReturn);
  if (!goal) return [];
  return searchNights(startDate, stops, goal.test, { maxDelta: goal.maxDelta, base: goal.base, nearStopId: check.stopId }, home).map((o) => ({
    label: describeNights(stops, o.changes),
    changes: o.changes,
    impact: o.impact,
  }));
}

interface Goal<S extends RuleStop> {
  test: (after: S[]) => boolean;
  maxDelta: number;
  base?: NightsChange[];
}

function goalFor<S extends RuleStop>(startDate: string, stops: readonly S[], check: Check, home: readonly RuleLeg[], latestReturn?: string | null): Goal<S> | null {
  const schedule = computeSchedule(startDate, stops);
  const at = (after: S[], stopId: string) => computeSchedule(startDate, after).stops.find((s) => s.stop.id === stopId);

  if (check.kind === "return-window" && latestReturn) {
    return {
      maxDelta: cap(daysBetween(latestReturn, schedule.returnDate), 10),
      test: (after) => computeSchedule(startDate, after).returnDate <= latestReturn,
    };
  }

  if (check.kind === "visa-days" && check.level === "error" && check.stopId) {
    const iso = stops.find((s) => s.id === check.stopId)?.countryIso;
    const country = visaSummaries(schedule).find((v) => v.countryIso === iso);
    if (!iso || !country) return null;
    const over = Math.max(...country.entries.map((e) => e.days - country.limitDays));
    return {
      maxDelta: cap(over, 10),
      test: (after) => {
        const now = visaSummaries(computeSchedule(startDate, after)).find((v) => v.countryIso === iso);
        return !now || (now.entries.length <= country.entries.length && now.entries.every((e) => !e.overLimit));
      },
    };
  }

  if (check.kind === "event" && check.level === "error" && check.stopId && check.activityId) {
    const stop = stops.find((s) => s.id === check.stopId);
    const when = stop?.planned?.find((a) => a.id === check.activityId)?.when as When | undefined;
    const placed = schedule.stops.find((s) => s.stop.id === check.stopId);
    if (!when || !placed || !("on" in when || "from" in when)) return null;
    const from = "on" in when ? when.on : when.from;
    const to = "on" in when ? when.on : when.to;
    const gap = from > placed.depart ? daysBetween(placed.depart, from) : daysBetween(to, placed.arrive);
    return {
      maxDelta: cap(gap),
      test: (after) => {
        const s = at(after, check.stopId!);
        return Boolean(s && eventFits(when, s.arrive, s.depart));
      },
    };
  }

  if ((check.kind === "stay-dates" || check.kind === "leg-day" || check.kind === "home-day") && (check.hotelId || check.legId)) {
    const all = routeAnchors(stops, home);
    const mine = all.filter((a) => (check.hotelId ? a.hotelId === check.hotelId && a.stopId === check.stopId : a.legId === check.legId));
    // A ticket that is only an idea has no anchor, but its date still says when the stop should start.
    if (!mine.length && check.legId && check.stopId) {
      const leg = stops.find((s) => s.id === check.stopId)?.legs?.find((l) => l.id === check.legId);
      const dep = leg?.departAt?.slice(0, 10);
      const placed = schedule.stops.find((s) => s.stop.id === check.stopId);
      if (!dep || !placed) return null;
      return {
        maxDelta: cap(daysBetween(placed.arrive, dep)),
        test: (after) => {
          const s = at(after, check.stopId!);
          return Boolean(s && (s.arrive === dep || s.arrive === addDays(dep, 1)));
        },
      };
    }
    if (!mine.length) return null;
    const states = anchorStates(schedule, mine);
    const maxDelta = cap(Math.max(...states.map((s) => daysBetween(s.planDate, s.from))));
    // A hotel booked for a different number of nights: start from the booked length.
    const inn = mine.find((a) => a.kind === "stay-in");
    const out = mine.find((a) => a.kind === "stay-out");
    const stop = stops.find((s) => s.id === check.stopId);
    const booked = inn && out ? daysBetween(inn.from, out.from) : null;
    const base = stop && booked != null && booked !== stop.nights ? [{ stopId: stop.id, nights: booked }] : undefined;
    return {
      maxDelta,
      base,
      test: (after) => anchorStates(computeSchedule(startDate, after), mine).every((s) => s.holds),
    };
  }
  return null;
}
