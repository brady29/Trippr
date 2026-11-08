import { shortDate } from "./dates";
import { eventFits, isFixedDate, whenLabel } from "./events";
import { computeSchedule } from "./schedule";
import type { Check, CheckLevel, ChecksResult, EventCheck, RuleStop } from "./types";
import { visaSummaries } from "./visa";

const LEVEL_RANK: Record<CheckLevel, number> = { ok: 0, info: 1, warn: 2, error: 3 };

export function worstLevel(levels: Iterable<CheckLevel>): CheckLevel {
  let worst: CheckLevel = "ok";
  for (const level of levels) if (LEVEL_RANK[level] > LEVEL_RANK[worst]) worst = level;
  return worst;
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * Every automatic check for one route: total nights, return date, visa-free
 * days per entry, number of entries, the policy end date, and fixed-date
 * events against the dates of the stop that plans them.
 */
export function runChecks<S extends RuleStop>(startDate: string, stops: readonly S[]): ChecksResult<S> {
  const schedule = computeSchedule(startDate, stops);
  const checks: Check[] = [
    {
      id: "total-nights",
      kind: "total-nights",
      level: "info",
      title: plural(schedule.totalNights, "night"),
      detail: `${plural(stops.length, "stop")}, ${shortDate(startDate)} to ${shortDate(schedule.returnDate)}`,
    },
    {
      id: "return-date",
      kind: "return-date",
      level: "info",
      title: `Home ${shortDate(schedule.returnDate)}`,
      detail: `Return date ${schedule.returnDate}`,
    },
  ];

  const visa = visaSummaries(schedule);
  for (const country of visa) {
    country.entries.forEach((entry, i) => {
      const over = entry.days - country.limitDays;
      checks.push({
        id: `visa-days-${country.countryIso}-${i + 1}`,
        kind: "visa-days",
        level: entry.overLimit ? "error" : "ok",
        title: `${country.countryName} entry ${i + 1}: ${entry.days} of ${country.limitDays} days`,
        detail:
          `${shortDate(entry.arrive)} to ${shortDate(entry.depart)} via ${entry.cities.join(", ")}` +
          (entry.overLimit ? `; ${plural(over, "day")} over the visa-free limit` : ""),
        stopId: entry.stopIds[0],
      });
      if (country.entriesUntil && entry.arrive > country.entriesUntil) {
        checks.push({
          id: `visa-policy-${country.countryIso}-${i + 1}`,
          kind: "visa-policy",
          level: "warn",
          title: `${country.countryName} visa-free policy ends before entry ${i + 1}`,
          detail: `Entries qualify until ${country.entriesUntil}; this entry is on ${entry.arrive}. Check whether it has been extended.`,
          stopId: entry.stopIds[0],
        });
      }
    });
    if (country.entries.length > 1) {
      checks.push({
        id: `visa-entries-${country.countryIso}`,
        kind: "visa-entries",
        level: "warn",
        title: `${plural(country.entries.length, "entry", "entries")} into ${country.countryName}`,
        detail: "Each entry is its own visa-free stay; consider merging the visits.",
      });
    }
  }

  const events: EventCheck[] = [];
  for (const { stop, arrive, depart } of schedule.stops) {
    for (const activity of stop.planned ?? []) {
      if (!isFixedDate(activity.when)) continue;
      const fits = eventFits(activity.when, arrive, depart);
      const label = whenLabel(activity.when);
      events.push({
        stopId: stop.id,
        activityId: activity.id,
        title: activity.title,
        fits,
        whenLabel: label,
        stopArrive: arrive,
        stopDepart: depart,
      });
      checks.push({
        id: `event-${stop.id}-${activity.id}`,
        kind: "event",
        level: fits ? "ok" : "error",
        title: `${activity.title}: ${fits ? "fits" : "outside your dates"}`,
        detail: `${label}; you are in ${stop.cityName} ${shortDate(arrive)} to ${shortDate(depart)}`,
        stopId: stop.id,
        activityId: activity.id,
      });
    }
  }

  return { schedule, visa, events, checks, level: worstLevel(checks.map((c) => c.level)) };
}
