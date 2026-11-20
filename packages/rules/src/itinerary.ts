/**
 * The route as a list of days: where you sleep, how you travel, what's planned
 * and what clashes. Pure, so the web app, the API and the calendar feed share it.
 *
 * A day belongs to the stop where you sleep that night. A planned activity's
 * day is stored as an offset from its stop's arrival (1 = arrival day), so
 * reordering the route moves activities with their stop.
 */
import { addDays, shortDate, weekday, weekdayName } from "./dates";
import type { When } from "./types";

export interface ItineraryLegInput {
  id: string;
  mode: string;
  from: { name: string; code?: string | null };
  to: { name: string; code?: string | null };
  operator?: string | null;
  number?: string | null;
  /** Local time with offset, e.g. 2027-05-19T08:05+08:00. */
  departAt?: string | null;
  arriveAt?: string | null;
  status?: string;
}

export interface ItineraryActivityInput {
  id: string;
  title: string;
  when?: When | null;
  day?: number | null;
  startTime?: string | null;
  durationMin?: number | null;
}

export interface ItineraryStopInput {
  id: string;
  nights: number;
  arrive: string;
  depart: string;
  arriveMode: string;
  city: { code: string; name: string; tz?: string | null };
  planned: ItineraryActivityInput[];
  legs: ItineraryLegInput[];
  stays: { status: string; hotel: { id: string; name: string } }[];
}

export type ConflictKind = "travel" | "closed" | "wrong_date" | "outside_stop";

export interface ItineraryConflict {
  kind: ConflictKind;
  message: string;
}

export interface ItineraryItem {
  activityId: string;
  stopId: string;
  /** The planned day within the stop (1 = arrival day); null when not on a day. */
  stopDay: number | null;
  title: string;
  startTime: string | null;
  durationMin: number | null;
  conflicts: ItineraryConflict[];
}

export interface ItineraryLeg extends ItineraryLegInput {
  stopId: string;
}

export type DayKind = "travel" | "full" | "light" | "free";

export interface ItineraryDay {
  /** 1-based across the whole trip. */
  index: number;
  date: string;
  /** The stop you sleep at that night (the last stop's departure day has none). */
  stopId: string | null;
  cityCode: string | null;
  cityName: string | null;
  tz: string | null;
  /** 1-based day within the stop, for planning onto it. */
  stopDay: number | null;
  kind: DayKind;
  stay: { name: string; status: string } | null;
  legs: ItineraryLeg[];
  items: ItineraryItem[];
}

export interface ItineraryStop {
  stopId: string;
  cityName: string;
  /** Days of this stop, as 1-based stop days, for pickers. */
  days: { stopDay: number; date: string }[];
  /** Planned here but not on a day yet. */
  unscheduled: ItineraryItem[];
  /** Planned on a day the stop no longer has (it got shorter). */
  needsNewDay: ItineraryItem[];
}

export interface Itinerary {
  days: ItineraryDay[];
  stops: ItineraryStop[];
}

/** Minutes to be at the station or airport before departure, by mode. */
const BUFFER_BEFORE: Record<string, number> = { flight: 120, hsr: 45, train: 45, maglev: 45, boat: 45 };
const BUFFER_AFTER = 30;
const DEFAULT_DURATION = 60;

const datePart = (t: string | null | undefined) => (t && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null);
const timePart = (t: string | null | undefined) => (t && /T(\d{2}:\d{2})/.test(t) ? t.match(/T(\d{2}:\d{2})/)![1]! : null);

/** UTC milliseconds for a local time with an explicit offset; null without one. */
export function instantOf(t: string | null | undefined): number | null {
  if (!t || !/T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})$/.test(t)) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/** The offset of a time zone from UTC on a date, in minutes (Asia/Tokyo → 540). */
export function tzOffsetMinutes(tz: string, date: string, time = "12:00"): number | null {
  try {
    const at = new Date(`${date}T${time}:00Z`);
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    if (!name) return null;
    if (name === "GMT") return 0;
    const m = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return null;
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    return null;
  }
}

/** UTC milliseconds for a local date and "HH:MM" in a time zone. */
export function localInstant(date: string, time: string, tz: string): number | null {
  const offset = tzOffsetMinutes(tz, date, time);
  if (offset == null) return null;
  return Date.parse(`${date}T${time}:00Z`) - offset * 60_000;
}

function whenConflict(when: When | null | undefined, date: string): ItineraryConflict | null {
  if (!when) return null;
  if ("on" in when && when.on !== date) return { kind: "wrong_date", message: `Happens on ${shortDate(when.on)}, not this day` };
  if ("from" in when && (date < when.from || date > when.to)) {
    return { kind: "wrong_date", message: `Only on ${shortDate(when.from)} to ${shortDate(when.to)}` };
  }
  if ("weekdays" in when && !when.weekdays.includes(weekday(date))) {
    return { kind: "closed", message: `Usually only on ${when.weekdays.map((d) => weekdayName(d)).join(", ")}` };
  }
  return null;
}

function legLabel(leg: ItineraryLegInput) {
  const what = leg.number ? `${leg.number}` : leg.mode === "flight" ? "flight" : leg.mode === "boat" ? "boat" : leg.mode === "road" ? "bus" : "train";
  return `the ${timePart(leg.departAt) ?? ""} ${what} to ${leg.to.name}`.replace(/\s+/g, " ");
}

function travelConflict(item: ItineraryActivityInput, date: string, tz: string | null | undefined, legs: ItineraryLeg[]): ItineraryConflict | null {
  if (!item.startTime || !tz) return null;
  const start = localInstant(date, item.startTime, tz);
  if (start == null) return null;
  const end = start + (item.durationMin ?? DEFAULT_DURATION) * 60_000;
  for (const leg of legs) {
    const dep = instantOf(leg.departAt);
    const arr = instantOf(leg.arriveAt);
    if (dep == null && arr == null) continue;
    const busyFrom = (dep ?? arr!) - (BUFFER_BEFORE[leg.mode] ?? 30) * 60_000;
    const busyTo = (arr ?? dep!) + BUFFER_AFTER * 60_000;
    if (start < busyTo && end > busyFrom) return { kind: "travel", message: `Clashes with ${legLabel(leg)}` };
  }
  return null;
}

const byTime = (a: ItineraryItem, b: ItineraryItem) =>
  (a.startTime ?? "99:99").localeCompare(b.startTime ?? "99:99") || a.title.localeCompare(b.title);

export function buildItinerary(stops: ItineraryStopInput[]): Itinerary {
  const days = new Map<string, ItineraryDay>();
  const day = (date: string): ItineraryDay => {
    let d = days.get(date);
    if (!d) {
      d = { index: 0, date, stopId: null, cityCode: null, cityName: null, tz: null, stopDay: null, kind: "free", stay: null, legs: [], items: [] };
      days.set(date, d);
    }
    return d;
  };

  // Nights: each stop owns the days it sleeps.
  for (const s of stops) {
    for (let i = 0; i < s.nights; i++) {
      const d = day(addDays(s.arrive, i));
      d.stopId = s.id;
      d.cityCode = s.city.code;
      d.cityName = s.city.name;
      d.tz = s.city.tz ?? null;
      d.stopDay = i + 1;
      const stay = s.stays.find((x) => x.status === "booked") ?? s.stays.find((x) => x.status === "chosen");
      d.stay = stay ? { name: stay.hotel.name, status: stay.status } : null;
    }
  }
  // The last stop's departure day, so the trip home has somewhere to go.
  const last = stops.at(-1);
  if (last) day(last.depart);

  // Travel: legs on their departure day; arrivals without legs still mark the day.
  // Clash checks look at every leg that leaves or lands that day.
  const travelDates = new Set<string>(last ? [last.depart] : []);
  const touching = new Map<string, ItineraryLeg[]>();
  const touch = (date: string | null, leg: ItineraryLeg) => {
    if (!date) return;
    const list = touching.get(date) ?? [];
    if (!list.includes(leg)) list.push(leg);
    touching.set(date, list);
  };
  for (const s of stops) {
    travelDates.add(s.arrive);
    for (const input of s.legs) {
      const leg: ItineraryLeg = { ...input, stopId: s.id };
      const date = datePart(leg.departAt) ?? datePart(leg.arriveAt) ?? s.arrive;
      day(date).legs.push(leg);
      travelDates.add(date);
      touch(datePart(leg.departAt) ?? date, leg);
      touch(datePart(leg.arriveAt), leg);
    }
  }

  // Planned activities.
  const stopSummaries: ItineraryStop[] = [];
  for (const s of stops) {
    const summary: ItineraryStop = {
      stopId: s.id,
      cityName: s.city.name,
      days: Array.from({ length: Math.max(s.nights, 1) }, (_, i) => ({ stopDay: i + 1, date: addDays(s.arrive, i) })),
      unscheduled: [],
      needsNewDay: [],
    };
    for (const a of s.planned) {
      const item: ItineraryItem = {
        activityId: a.id,
        stopId: s.id,
        stopDay: a.day ?? null,
        title: a.title,
        startTime: a.startTime ?? null,
        durationMin: a.durationMin ?? null,
        conflicts: [],
      };
      if (a.day == null) {
        summary.unscheduled.push(item);
        continue;
      }
      if (a.day > Math.max(s.nights, 1)) {
        item.conflicts.push({ kind: "outside_stop", message: `${s.city.name} is ${s.nights} night${s.nights === 1 ? "" : "s"} now` });
        summary.needsNewDay.push(item);
        continue;
      }
      const date = addDays(s.arrive, a.day - 1);
      const target = day(date);
      const when = whenConflict(a.when, date);
      if (when) item.conflicts.push(when);
      const travel = travelConflict(a, date, s.city.tz, touching.get(date) ?? []);
      if (travel) item.conflicts.push(travel);
      target.items.push(item);
    }
    summary.unscheduled.sort(byTime);
    stopSummaries.push(summary);
  }

  const ordered = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  ordered.forEach((d, i) => {
    d.index = i + 1;
    d.items.sort(byTime);
    d.legs.sort((a, b) => (a.departAt ?? "").localeCompare(b.departAt ?? ""));
    const busyMinutes = d.items.reduce((sum, it) => sum + (it.durationMin ?? DEFAULT_DURATION), 0);
    d.kind = travelDates.has(d.date) || d.legs.length ? "travel" : d.items.length === 0 ? "free" : d.items.length >= 3 || busyMinutes >= 360 ? "full" : "light";
  });
  return { days: ordered, stops: stopSummaries };
}
