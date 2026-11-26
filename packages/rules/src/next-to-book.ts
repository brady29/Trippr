import { addDays, daysBetween, shortDate, weekday } from "./dates";
import { computeSchedule } from "./schedule";
import type { RuleLeg, RuleStop, When } from "./types";

/**
 * What to book next, by risk: what would become a fixed date (the flight
 * home, flights), fares the price tracker says to buy, nights around a
 * fixed-date event, and anything already held or chosen that only needs
 * confirming. Ties go to the earlier date.
 */
export interface NextStop extends RuleStop {
  /** How the stop is reached ("flight", "hsr", ...). */
  arriveMode?: string;
}

export interface NextToBookItem {
  /** "deadline": a booking whose free cancellation ends soon, so decide now. */
  kind: "transport" | "stay" | "home" | "deadline";
  /** The stop it's for; absent for the trip home. */
  stopId?: string;
  /** "Flight to Beijing", "Hotel in Kyoto", "Flight home". */
  title: string;
  /** Why it's this high, in plain words, most important first. */
  reasons: string[];
  /** The date it's for (travel day, or check-in). */
  date: string;
  score: number;
}

export interface NextToBookInput {
  startDate: string;
  stops: readonly NextStop[];
  home?: readonly RuleLeg[];
  /** The price tracker's advice per stop's flight in: "buy" pushes it up. */
  fareVerdicts?: Record<string, "buy" | "wait" | "watch" | null | undefined>;
  /** Today, YYYY-MM-DD, for cancellation deadlines (left out: none are shown). */
  today?: string;
  /** How far ahead a deadline counts as soon, in days. */
  deadlineDays?: number;
}

const MODE_NOUN: Record<string, string> = { flight: "Flight", hsr: "Train", train: "Train", road: "Transport", boat: "Ferry" };

function fixedEventIn(stop: RuleStop, arrive: string, depart: string): string | null {
  for (const a of stop.planned ?? []) {
    const w = a.when as When | null | undefined;
    if (!w) continue;
    const from = "on" in w ? w.on : "from" in w ? w.from : null;
    const to = "on" in w ? w.on : "from" in w ? w.to : null;
    if (from && to && from <= depart && to >= arrive) return a.title;
  }
  return null;
}

export function nextToBook({ startDate, stops, home = [], fareVerdicts = {}, today, deadlineDays = 14 }: NextToBookInput): NextToBookItem[] {
  const schedule = computeSchedule(startDate, stops);
  const items: NextToBookItem[] = [];

  schedule.stops.forEach(({ stop, arrive, depart }, i) => {
    const legs = stop.legs ?? [];
    const mode = stop.arriveMode ?? "flight";
    if (!legs.some((l) => l.status === "booked")) {
      const reasons: string[] = [];
      let score = 10;
      if (legs.some((l) => l.status === "held")) {
        score += 25;
        reasons.push("Held: it only needs confirming");
      }
      if (fareVerdicts[stop.id] === "buy") {
        score += 30;
        reasons.push("The fare tracker says this is a good time to buy");
      }
      if (mode === "flight") {
        score += 25;
        reasons.push("Flights get dearer closer to the date, and a booked one fixes the day you arrive");
      } else if (mode === "hsr" || mode === "train") {
        score += 8;
        reasons.push("Fixes the day you arrive");
      }
      if (i === 0) {
        score += 10;
        reasons.push("Starts the trip");
      }
      items.push({ kind: "transport", stopId: stop.id, title: `${MODE_NOUN[mode] ?? "Transport"} to ${stop.cityName}`, reasons, date: arrive, score });
    }

    if (stop.nights > 0 && !(stop.stays ?? []).some((s) => s.status === "booked")) {
      const reasons: string[] = [];
      let score = 12;
      if ((stop.stays ?? []).some((s) => s.status === "chosen")) {
        score += 20;
        reasons.push("Chosen: it only needs booking");
      }
      const event = fixedEventIn(stop, arrive, depart);
      if (event) {
        score += 22;
        reasons.push(`${event} is on while you're there, so rooms go fast`);
      }
      let weekendNights = 0;
      for (let d = arrive; d < depart; d = addDays(d, 1)) if ([5, 6].includes(weekday(d))) weekendNights++;
      if (weekendNights) {
        score += 4;
        reasons.push(`${weekendNights} weekend night${weekendNights === 1 ? "" : "s"}`);
      }
      if (!reasons.length) reasons.push(`${stop.nights} night${stop.nights === 1 ? "" : "s"} from ${shortDate(arrive)}`);
      items.push({ kind: "stay", stopId: stop.id, title: `Hotel in ${stop.cityName}`, reasons, date: arrive, score });
    }
  });

  if (stops.length && !home.some((l) => l.status === "booked")) {
    const reasons = ["Fixes the home date, so the rest of the plan has a frame"];
    let score = 50;
    if (home.some((l) => l.status === "held")) {
      score += 15;
      reasons.unshift("Held: it only needs confirming");
    }
    items.push({ kind: "home", title: "Flight home", reasons, date: schedule.returnDate, score });
  }

  // Free cancellation that ends soon: decide whether to keep the booking before it becomes final.
  if (today) {
    const soon = addDays(today, deadlineDays);
    const deadline = (name: string, until: string | null | undefined, stopId?: string) => {
      if (!until || until < today || until > soon) return;
      const left = daysBetween(today, until);
      items.push({
        kind: "deadline",
        ...(stopId ? { stopId } : {}),
        title: `Free cancellation on ${name} ends`,
        reasons: [left === 0 ? "Last day to cancel for free" : `${left} day${left === 1 ? "" : "s"} left to cancel for free, then it's final`],
        date: until,
        score: 80 - left,
      });
    };
    for (const s of stops) {
      for (const l of s.legs ?? []) if (l.status === "booked") deadline(l.label ?? `the ticket to ${s.cityName}`, l.freeCancelUntil, s.id);
      for (const st of s.stays ?? []) if (st.status === "booked") deadline(st.name, st.freeCancelUntil, s.id);
    }
    for (const l of home) if (l.status === "booked") deadline(l.label ?? "the flight home", l.freeCancelUntil);
  }

  return items.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
}
