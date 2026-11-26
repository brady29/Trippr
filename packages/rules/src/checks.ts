import { addDays, daysBetween, shortDate } from "./dates";
import { eventFits, isFixedDate, whenLabel } from "./events";
import { computeSchedule } from "./schedule";
import type { Check, CheckLevel, ChecksResult, EventCheck, RuleLeg, RuleStop } from "./types";
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
export function runChecks<S extends RuleStop>(
  startDate: string,
  stops: readonly S[],
  home: readonly RuleLeg[] = [],
  /** The latest the group can be home, from trip setup's date range. */
  latestReturn?: string | null,
): ChecksResult<S> {
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

  for (const { stop, arrive, depart } of schedule.stops) {
    // A leg into a stop departs on the arrival day, or the day before for an overnight train or flight.
    for (const leg of stop.legs ?? []) {
      const day = leg.departAt?.slice(0, 10);
      if (!day || day === arrive || day === addDays(arrive, -1)) continue;
      checks.push({
        id: `leg-day-${stop.id}-${leg.id}`,
        kind: "leg-day",
        level: "warn",
        title: `${leg.label ?? "A ticket"} into ${stop.cityName} departs ${shortDate(day)}`,
        detail: `You arrive in ${stop.cityName} on ${shortDate(arrive)}; the ticket should depart that day or the day before.`,
        stopId: stop.id,
        legId: leg.id,
      });
    }
    // A booked hotel keeps the dates it was booked for; a reorder can move the stop away from them.
    for (const stay of stop.stays ?? []) {
      if (stay.status !== "booked" || !stay.arrive || !stay.depart) continue;
      if (stay.arrive === arrive && stay.depart === depart) continue;
      checks.push({
        id: `stay-dates-${stop.id}-${stay.hotelId}`,
        kind: "stay-dates",
        level: "warn",
        title: `${stay.name} is booked for other dates`,
        detail: `Booked ${shortDate(stay.arrive)} to ${shortDate(stay.depart)}; you are now in ${stop.cityName} ${shortDate(arrive)} to ${shortDate(depart)}.`,
        stopId: stop.id,
        hotelId: stay.hotelId,
      });
    }
  }

  if (latestReturn && schedule.returnDate > latestReturn) {
    const over = daysBetween(latestReturn, schedule.returnDate);
    checks.push({
      id: "return-window",
      kind: "return-window",
      level: "error",
      title: `Home ${shortDate(schedule.returnDate)}, ${plural(over, "day")} after your latest return`,
      detail: `The trip has to end by ${shortDate(latestReturn)}.`,
    });
  }

  // The ticket home leaves on the home date: the day you leave the last stop. An overnight flight with only
  // an arrival time can land the day after.
  const homeLeg = home.find((l) => l.departAt || l.arriveAt);
  const last = schedule.stops.at(-1);
  if (homeLeg && last) {
    const dep = homeLeg.departAt?.slice(0, 10);
    const arr = homeLeg.arriveAt?.slice(0, 10);
    const ok = dep ? dep === schedule.returnDate : arr === schedule.returnDate || arr === addDays(schedule.returnDate, 1);
    if (!ok) {
      checks.push({
        id: `home-day-${homeLeg.id}`,
        kind: "home-day",
        level: "warn",
        title: `${homeLeg.label ?? "The ticket home"} ${dep ? `departs ${shortDate(dep)}` : `arrives ${shortDate(arr!)}`}`,
        detail: `You leave ${last.stop.cityName} on ${shortDate(schedule.returnDate)}; the ticket home should leave that day.`,
        legId: homeLeg.id,
      });
    }
  }

  return { schedule, visa, events, checks, level: worstLevel(checks.map((c) => c.level)) };
}
