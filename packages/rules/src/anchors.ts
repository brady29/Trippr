import { addDays, shortDate } from "./dates";
import { eventFits } from "./events";
import { computeSchedule } from "./schedule";
import type { RuleLeg, RuleStop, Schedule, When } from "./types";

/**
 * Anchors: dates the plan has to keep because something real depends on them.
 *
 * Dates are computed from the trip start and each stop's nights, so any edit
 * can move every later stop. A booked ticket or hotel keeps its own date,
 * though. Anchors name those dates so the builder can protect them: it looks
 * for a change that keeps every booking first, and moving one is a choice.
 *
 * - "booked" anchors come from booked tickets and booked hotels, and a booked
 *   ticket home, which fixes the home date.
 * - "soft" anchors come from held tickets and fixed-date events. They are
 *   shown and mentioned, but never stop an edit.
 */
export type AnchorStrength = "booked" | "soft";

/** Which date the anchor pins: a stop's arrival or departure, a date inside the stay, or the home date. */
export type AnchorSide = "arrive" | "depart" | "within" | "home";

/** Stands in for a stop id on anchors that belong to the trip home rather than a stop. */
export const HOME = "home";

export interface Anchor {
  id: string;
  kind: "leg" | "stay-in" | "stay-out" | "event" | "home";
  strength: AnchorStrength;
  side: AnchorSide;
  /** The stop it belongs to, or HOME. */
  stopId: string;
  /** Earliest and latest date that satisfy it (equal for most anchors; a day apart for a ticket with only one time). */
  from: string;
  to: string;
  /** What depends on it, for people: "Shinkansen Hikari 509", "Ryokan Yachiyo check-in". */
  label: string;
  /** The booking itself, the same for a hotel's check-in and check-out: "Ryokan Yachiyo". */
  booking: string;
  legId?: string;
  hotelId?: string;
  activityId?: string;
  /** The last day the booking can be cancelled for free. Before then it can still move, at no cost. */
  refundableUntil?: string | null;
}

export interface AnchorState extends Anchor {
  /** The date the current plan gives that side (the arrival day for "within", the home date for "home"). */
  planDate: string;
  holds: boolean;
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

function eventWindow(when: When | null | undefined): { from: string; to: string } | null {
  if (!when) return null;
  if ("on" in when && typeof when.on === "string") return { from: when.on, to: when.on };
  if ("from" in when && typeof when.from === "string" && typeof when.to === "string") return { from: when.from, to: when.to };
  return null; // Weekly events recur, so they never pin a date.
}

const legStrength = (leg: RuleLeg): AnchorStrength | null => (leg.status === "booked" ? "booked" : leg.status === "held" ? "soft" : null);

/** Every anchor on a route, in stop order, then the trip home. Ideas, shortlisted and chosen hotels add none. */
export function routeAnchors(stops: readonly RuleStop[], home: readonly RuleLeg[] = []): Anchor[] {
  const out: Anchor[] = [];
  for (const stop of stops) {
    for (const leg of stop.legs ?? []) {
      const strength = legStrength(leg);
      if (!strength) continue;
      const label = leg.label ?? "A ticket";
      const arrive = day(leg.arriveAt);
      const depart = day(leg.departAt);
      // An overnight journey with no arrival time can land the next day, as the leg-day check allows.
      const range = arrive ? { from: arrive, to: arrive } : depart ? { from: depart, to: addDays(depart, 1) } : null;
      if (!range) continue;
      out.push({ id: `leg-${leg.id}`, kind: "leg", strength, side: "arrive", stopId: stop.id, ...range, label, booking: label, legId: leg.id, refundableUntil: leg.freeCancelUntil ?? null });
    }
    for (const stay of stop.stays ?? []) {
      if (stay.status !== "booked" || !stay.arrive || !stay.depart) continue;
      const base = { strength: "booked" as const, stopId: stop.id, hotelId: stay.hotelId, booking: stay.name, refundableUntil: stay.freeCancelUntil ?? null };
      out.push({ ...base, id: `stay-in-${stop.id}-${stay.hotelId}`, kind: "stay-in", side: "arrive", from: stay.arrive, to: stay.arrive, label: `${stay.name} check-in` });
      out.push({ ...base, id: `stay-out-${stop.id}-${stay.hotelId}`, kind: "stay-out", side: "depart", from: stay.depart, to: stay.depart, label: `${stay.name} check-out` });
    }
    for (const a of stop.planned ?? []) {
      const w = eventWindow(a.when);
      if (!w) continue;
      out.push({ id: `event-${stop.id}-${a.id}`, kind: "event", strength: "soft", side: "within", stopId: stop.id, ...w, label: a.title, booking: a.title, activityId: a.id });
    }
  }
  // The first ticket home leaves on the home date (the day you leave the last stop).
  const first = home.find((l) => legStrength(l) && (l.departAt || l.arriveAt));
  if (first) {
    const depart = day(first.departAt);
    const arrive = day(first.arriveAt);
    // With only an arrival time, an overnight flight may have left the day before.
    const range = depart ? { from: depart, to: depart } : { from: addDays(arrive!, -1), to: arrive! };
    const label = first.label ?? "The ticket home";
    out.push({ id: `home-${first.id}`, kind: "home", strength: legStrength(first)!, side: "home", stopId: HOME, ...range, label, booking: label, legId: first.id, refundableUntil: first.freeCancelUntil ?? null });
  }
  return out;
}

/** Whether each anchor holds under a schedule. An anchor whose stop is gone holds trivially (it went with the stop). */
export function anchorStates<S extends RuleStop>(schedule: Schedule<S>, anchors: readonly Anchor[]): AnchorState[] {
  const byId = new Map(schedule.stops.map((s) => [s.stop.id, s]));
  return anchors.flatMap((a) => {
    if (a.side === "home") {
      const planDate = schedule.returnDate;
      return [{ ...a, planDate, holds: planDate >= a.from && planDate <= a.to }];
    }
    const s = byId.get(a.stopId);
    if (!s) return [];
    if (a.side === "within") {
      const when: When = a.from === a.to ? { on: a.from } : { from: a.from, to: a.to };
      return [{ ...a, planDate: s.arrive, holds: eventFits(when, s.arrive, s.depart) }];
    }
    const planDate = a.side === "arrive" ? s.arrive : s.depart;
    return [{ ...a, planDate, holds: planDate >= a.from && planDate <= a.to }];
  });
}

/** A stop's freedom: "booked" has a booked hotel; "boxed" sits between two booked dates; "free" can change on its own. */
export type StopLock = "free" | "boxed" | "booked";

export interface RouteAnchors {
  anchors: AnchorState[];
  /** Per stop id. */
  locks: Record<string, StopLock>;
  /** Booked anchors the plan no longer keeps. */
  broken: AnchorState[];
  /** The home date is fixed by a booked ticket home. */
  homeFixed: boolean;
}

/**
 * A stop's arrival is pinned by the trip start (first stop), a booked ticket
 * into it, or a booked hotel check-in there; its departure by a booked hotel
 * check-out there, by whatever pins the next stop's arrival, or for the last
 * stop by a booked ticket home.
 */
export function describeAnchors(startDate: string, stops: readonly RuleStop[], home: readonly RuleLeg[] = []): RouteAnchors {
  const schedule = computeSchedule(startDate, stops);
  const anchors = anchorStates(schedule, routeAnchors(stops, home));
  const hard = anchors.filter((a) => a.strength === "booked");
  const homeFixed = hard.some((a) => a.side === "home");
  const arrivePinned = (i: number) =>
    i === 0 ||
    hard.some((a) => (a.stopId === stops[i]!.id && a.side === "arrive") || (a.stopId === stops[i - 1]!.id && a.side === "depart"));
  const locks: Record<string, StopLock> = {};
  stops.forEach((s, i) => {
    const last = i + 1 === stops.length;
    const departPinned = hard.some((a) => a.stopId === s.id && a.side === "depart") || (last ? homeFixed : arrivePinned(i + 1));
    const hasBookedStay = hard.some((a) => a.stopId === s.id && a.kind === "stay-in");
    locks[s.id] = hasBookedStay ? "booked" : arrivePinned(i) && departPinned ? "boxed" : "free";
  });
  return { anchors, locks, broken: hard.filter((a) => !a.holds), homeFixed };
}

/** What an edit does to the anchors and the home date. */
export interface EditImpact {
  /** Booked anchors that held before and not after. */
  breaks: AnchorState[];
  /** Booked anchors that were broken and now hold again. */
  fixes: AnchorState[];
  /** Soft anchors (held tickets, events) that held before and not after. */
  softBreaks: AnchorState[];
  homeBefore: string;
  homeAfter: string;
}

/**
 * Compare two versions of a route. The anchors come from `before`, so a
 * booking keeps its date whatever the edit does to the stops around it.
 */
export function editImpact<S extends RuleStop>(startDate: string, before: readonly S[], after: readonly S[], home: readonly RuleLeg[] = []): EditImpact {
  return impactFrom(startDate, before, home)(after);
}

/** editImpact with the "before" side worked out once, for searches that try many edits. */
export function impactFrom<S extends RuleStop>(startDate: string, before: readonly S[], home: readonly RuleLeg[] = []): (after: readonly S[]) => EditImpact {
  const anchors = routeAnchors(before, home);
  const a = computeSchedule(startDate, before);
  const was = new Map(anchorStates(a, anchors).map((s) => [s.id, s]));
  return (after) => {
    const b = computeSchedule(startDate, after);
    const breaks: AnchorState[] = [];
    const fixes: AnchorState[] = [];
    const softBreaks: AnchorState[] = [];
    for (const s of anchorStates(b, anchors)) {
      const old = was.get(s.id);
      if (!old) continue;
      if (old.holds && !s.holds) (s.strength === "booked" ? breaks : softBreaks).push(s);
      if (!old.holds && s.holds && s.strength === "booked") fixes.push(s);
    }
    return { breaks, fixes, softBreaks, homeBefore: a.returnDate, homeAfter: b.returnDate };
  };
}

export interface NightsChange {
  stopId: string;
  nights: number;
}

export interface NightsOption {
  /** "trade" moves nights between two stops; "shift" changes stops and lets later dates move. */
  kind: "trade" | "shift";
  changes: NightsChange[];
  /** The other stop in a trade. */
  withStopId?: string;
  impact: EditImpact;
}

export interface NightsPlan {
  /** True when the plain change keeps every booking: apply it without asking. */
  free: boolean;
  /** The plain change on its own. */
  shift: NightsOption;
  /** Trades that keep every booking, best first (fewest soft breaks, then the nearest stop). At most three. */
  trades: NightsOption[];
}

export const withNights = <S extends RuleStop>(stops: readonly S[], changes: readonly NightsChange[]): S[] =>
  stops.map((s) => {
    const c = changes.find((x) => x.stopId === s.id);
    return c ? { ...s, nights: c.nights } : s;
  });

/**
 * One more or one fewer night at a stop. If that would move a booked date,
 * look for another stop to trade the night with so every booking stays put.
 */
export function planNights<S extends RuleStop>(startDate: string, stops: readonly S[], stopId: string, delta: number, home: readonly RuleLeg[] = []): NightsPlan {
  const i = stops.findIndex((s) => s.id === stopId);
  if (i < 0) throw new RangeError(`No stop ${stopId}`);
  const target = stops[i]!.nights + delta;
  if (!Number.isInteger(target) || target < 0) throw new RangeError(`Stop ${stopId} cannot have ${target} nights`);
  const shiftChanges = [{ stopId, nights: target }];
  const shift: NightsOption = { kind: "shift", changes: shiftChanges, impact: editImpact(startDate, stops, withNights(stops, shiftChanges), home) };
  if (shift.impact.breaks.length === 0) return { free: true, shift, trades: [] };

  const trades: (NightsOption & { distance: number })[] = [];
  stops.forEach((other, j) => {
    if (j === i || other.nights - delta < 0) return;
    const changes = [...shiftChanges, { stopId: other.id, nights: other.nights - delta }];
    const impact = editImpact(startDate, stops, withNights(stops, changes), home);
    if (impact.breaks.length) return;
    trades.push({ kind: "trade", changes, withStopId: other.id, impact, distance: Math.abs(j - i) });
  });
  trades.sort((a, b) => a.impact.softBreaks.length - b.impact.softBreaks.length || a.distance - b.distance);
  return { free: false, shift, trades: trades.slice(0, 3).map(({ distance: _d, ...t }) => t) };
}

export interface InsertPlan {
  /** Adding the stop and letting later dates move. */
  impact: EditImpact;
  /** Adding it and taking its nights from one other stop so every booking stays put, best first. At most three. */
  trades: NightsOption[];
}

/** What adding a stop at a position does, and which stop could give up the nights so no booking moves. */
export function planInsert<S extends RuleStop>(startDate: string, stops: readonly S[], added: S, position: number, home: readonly RuleLeg[] = []): InsertPlan {
  const at = Math.max(0, Math.min(position, stops.length));
  const inserted = [...stops.slice(0, at), added, ...stops.slice(at)];
  const measure = impactFrom(startDate, stops, home);
  const impact = measure(inserted);
  if (!impact.breaks.length || added.nights === 0) return { impact, trades: [] };
  const trades: (NightsOption & { distance: number })[] = [];
  stops.forEach((other, j) => {
    if (other.nights < added.nights) return;
    const changes = [{ stopId: other.id, nights: other.nights - added.nights }];
    const t = measure(withNights(inserted, changes));
    if (t.breaks.length) return;
    trades.push({ kind: "trade", changes, withStopId: other.id, impact: t, distance: Math.abs(j - at) });
  });
  trades.sort((a, b) => a.impact.softBreaks.length - b.impact.softBreaks.length || a.distance - b.distance);
  return { impact, trades: trades.slice(0, 3).map(({ distance: _d, ...t }) => t) };
}

export interface SearchOptions {
  /** Largest change to try at one stop, in nights. */
  maxDelta: number;
  /** Changes every candidate starts from (say, the booked number of nights at a hotel's stop). */
  base?: NightsChange[];
  /** Stop the search is about: nearer changes rank first. */
  nearStopId?: string;
  /** At most this many options (default 3). */
  limit?: number;
}

/**
 * The smallest nights changes that make `goal` true without moving any
 * booking that is on its dates now. Tries one stop, then trades between two
 * stops (which keep the home date), on top of `base`. Best first: fewest soft
 * anchors broken, the home date kept, the fewest nights moved, the nearest stops.
 */
export function searchNights<S extends RuleStop>(
  startDate: string,
  stops: readonly S[],
  goal: (after: S[]) => boolean,
  { maxDelta, base = [], nearStopId, limit = 3 }: SearchOptions,
  home: readonly RuleLeg[] = [],
): NightsOption[] {
  const baseNights = new Map(base.map((c) => [c.stopId, c.nights]));
  const nightsOf = (s: S) => baseNights.get(s.id) ?? s.nights;
  const measure = impactFrom(startDate, stops, home);
  const near = nearStopId ? stops.findIndex((s) => s.id === nearStopId) : -1;
  const found = new Map<string, NightsOption & { cost: number[] }>();

  const consider = (extra: NightsChange[], kind: NightsOption["kind"]) => {
    const merged = new Map(base.map((c) => [c.stopId, c.nights]));
    for (const c of extra) merged.set(c.stopId, c.nights);
    const changes = [...merged].map(([stopId, nights]) => ({ stopId, nights })).filter((c) => stops.find((s) => s.id === c.stopId)!.nights !== c.nights);
    if (!changes.length || changes.some((c) => c.nights < 0)) return;
    const key = changes.map((c) => `${c.stopId}:${c.nights}`).sort().join("|");
    if (found.has(key)) return;
    const after = withNights(stops, changes);
    if (!goal(after)) return;
    const impact = measure(after);
    if (impact.breaks.length) return;
    const moved = changes.reduce((n, c) => n + Math.abs(c.nights - stops.find((s) => s.id === c.stopId)!.nights), 0);
    const distance = near < 0 ? 0 : changes.reduce((n, c) => n + Math.abs(stops.findIndex((s) => s.id === c.stopId) - near), 0);
    const cost = [impact.softBreaks.length, impact.homeBefore === impact.homeAfter ? 0 : 1, moved, changes.length, distance];
    const trade = changes.length === 2 && changes.reduce((n, c) => n + c.nights - stops.find((s) => s.id === c.stopId)!.nights, 0) === 0;
    found.set(key, { kind: trade ? "trade" : kind, changes, impact, cost, ...(trade ? { withStopId: changes[1]!.stopId } : {}) });
  };

  consider([], "shift");
  for (const s of stops) {
    for (let d = -maxDelta; d <= maxDelta; d++) if (d) consider([{ stopId: s.id, nights: nightsOf(s) + d }], "shift");
  }
  stops.forEach((a, i) => {
    stops.forEach((b, j) => {
      if (j <= i) return;
      for (let d = -maxDelta; d <= maxDelta; d++) {
        if (!d) continue;
        consider([{ stopId: a.id, nights: nightsOf(a) + d }, { stopId: b.id, nights: nightsOf(b) - d }], "trade");
      }
    });
  });
  const cmp = (x: number[], y: number[]) => {
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k]! - y[k]!;
    return 0;
  };
  return [...found.values()]
    .sort((a, b) => cmp(a.cost, b.cost))
    .slice(0, limit)
    .map(({ cost: _c, ...o }) => o);
}

/** "Shinkansen Hikari 509 (May 15)" for a sentence. */
export function anchorPhrase(a: Anchor): string {
  return `${a.label} (${a.from === a.to ? shortDate(a.from) : `${shortDate(a.from)} to ${shortDate(a.to)}`})`;
}

/** True when every one of these anchors can still be changed for free on `today`. */
export function allRefundable(anchors: readonly Anchor[], today: string): boolean {
  return anchors.length > 0 && anchors.every((a) => Boolean(a.refundableUntil && a.refundableUntil >= today));
}

/** The distinct bookings behind some anchors: a hotel's check-in and check-out count once. */
export function bookingNames(anchors: readonly Anchor[]): string[] {
  return [...new Set(anchors.map((a) => a.booking))];
}

/** "Shinkansen Hikari 509", "the Shinkansen and Ryokan Yachiyo", "A, B and 2 more". */
export function listNames(names: readonly string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length > max) return `${names.slice(0, max - 1).join(", ")} and ${names.length - (max - 1)} more`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const nightWord = (n: number) => (n === 1 ? "a night" : `${n} nights`);

/** A nights change in words: "Take 2 nights from Beijing", "Move a night from Osaka to Tokyo", "Kyoto 3 → 4 nights". */
export function describeNights(stops: readonly RuleStop[], changes: readonly NightsChange[]): string {
  const rows = changes.map((c) => {
    const s = stops.find((x) => x.id === c.stopId)!;
    return { name: s.cityName, from: s.nights, to: c.nights, d: c.nights - s.nights };
  });
  if (rows.length === 1) {
    const r = rows[0]!;
    return r.d > 0 ? `Add ${nightWord(r.d)} in ${r.name}` : `Take ${nightWord(-r.d)} from ${r.name}`;
  }
  if (rows.length === 2 && rows[0]!.d + rows[1]!.d === 0) {
    const [give, take] = rows[0]!.d < 0 ? [rows[0]!, rows[1]!] : [rows[1]!, rows[0]!];
    return `Move ${nightWord(take.d)} from ${give.name} to ${take.name}`;
  }
  return rows.map((r) => `${r.name} ${r.from} → ${r.to}`).join(", ");
}
