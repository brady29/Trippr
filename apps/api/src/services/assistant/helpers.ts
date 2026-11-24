import type Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantCitation,
  AssistantRefLabel,
  AssistantRefs,
  AssistantTurn,
  BookingItem,
  BookingsResult,
  CompareResult,
  Hotel,
  LibraryActivity,
  PathResult,
  RouteView,
  SearchResponse,
  TripDetail,
} from "@trippr/contracts";
import { distanceKm, type Itinerary } from "@trippr/rules";

/**
 * Pure helpers for the trip assistant: the cached trip snapshot, compact tool
 * results, and the references an answer ends with. Everything the model sees
 * goes through here, so ids it may cite are recorded as they pass.
 */

/** Ids the model has been shown this question; only these may come back as references. */
export class Seen {
  readonly stops = new Map<string, string>();
  readonly activities = new Map<string, string>();
  readonly legs = new Map<string, string>();
  readonly hotels = new Map<string, string>();
  readonly cities = new Map<string, string>();

  stop(id: string, label: string) {
    this.stops.set(id, label);
  }
  activity(id: string, label: string) {
    this.activities.set(id, label);
  }
  leg(id: string, label: string) {
    this.legs.set(id, label);
  }
  hotel(id: string, label: string) {
    this.hotels.set(id, label);
  }
  city(code: string, label: string) {
    this.cities.set(code, label);
  }

  /** Drops ids the model never saw (made up, or from another trip), and duplicates. */
  filter(refs: AssistantRefs): AssistantRefs {
    const keep = (ids: string[], known: Map<string, string>) => [...new Set(ids)].filter((id) => known.has(id)).slice(0, 20);
    return {
      stopIds: keep(refs.stopIds, this.stops),
      activityIds: keep(refs.activityIds, this.activities),
      legIds: keep(refs.legIds, this.legs),
      hotelIds: keep(refs.hotelIds, this.hotels),
      cityCodes: keep(refs.cityCodes, this.cities),
    };
  }

  labels(refs: AssistantRefs): AssistantRefLabel[] {
    return [
      ...refs.stopIds.map((id) => ({ kind: "stop" as const, id, label: this.stops.get(id)! })),
      ...refs.activityIds.map((id) => ({ kind: "activity" as const, id, label: this.activities.get(id)! })),
      ...refs.legIds.map((id) => ({ kind: "leg" as const, id, label: this.legs.get(id)! })),
      ...refs.hotelIds.map((id) => ({ kind: "hotel" as const, id, label: this.hotels.get(id)! })),
      ...refs.cityCodes.map((id) => ({ kind: "city" as const, id, label: this.cities.get(id)! })),
    ];
  }
}

const money = (n: number | null | undefined) => (n == null ? null : Math.round(n));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Removes null, undefined, empty strings and empty arrays so tool results stay small. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => compact(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
      out[k] = compact(v);
    }
    return out as T;
  }
  return value;
}

/** Tool results go back as compact JSON, cut at a size that keeps one question cheap. */
export const MAX_TOOL_RESULT_CHARS = 12_000;
export function toolJson(value: unknown): string {
  const text = JSON.stringify(compact(value));
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}… (cut; ask a narrower question)` : text;
}

const stopLabel = (s: { city: { name: string }; order: number }) => `${s.city.name} (stop ${s.order + 1})`;
const legLabel = (l: { mode: string; from: { name: string }; to: { name: string }; number?: string | null }) =>
  `${l.number ? `${l.number} ` : ""}${l.mode} ${l.from.name} → ${l.to.name}`;

/** Records every id a route view shows, so the answer can cite them. */
export function seeRoute(view: RouteView, seen: Seen) {
  for (const s of view.stops) {
    seen.stop(s.id, stopLabel(s));
    seen.city(s.city.code, s.city.name);
    for (const p of s.planned) seen.activity(p.id, p.title);
    for (const l of s.legs) seen.leg(l.id, legLabel(l));
    for (const st of s.stays) seen.hotel(st.hotel.id, st.hotel.name);
  }
}

/**
 * The trip at a glance, sent with every question and prompt-cached: routes,
 * the current route's stops with dates and nights, and counts. Details come
 * from tools. Nothing per-user or per-day goes in here, so the cache is
 * shared by every member asking about the same version of the trip.
 */
export function buildSnapshot(detail: TripDetail, current: RouteView | null, seen: Seen): string {
  const { trip } = detail;
  const lines: string[] = [];
  lines.push(
    `Trip: ${trip.name} (id ${trip.id}). Starts ${trip.startDate}. ${plural(trip.travellers ?? 1, "traveller")}${trip.homeCity ? `, home city ${trip.homeCity}` : ""}.`,
  );
  lines.push(`Members: ${detail.members.map((m) => `${m.name} (${m.role})`).join(", ") || "none"}.`);
  lines.push("", "Routes (route id | name | stops | nights | back home | est. CAD per person | cities):");
  for (const r of detail.routes) {
    lines.push(
      `- ${r.id} | ${r.name}${r.isCurrent ? " [current]" : ""}${r.tags.length ? ` [${r.tags.join(", ")}]` : ""} | ${r.stopCount} | ${r.totalNights} | ${r.returnDate} | ${money(r.perPersonCad)} | ${r.cities.join(", ")}`,
    );
  }
  if (current) {
    seeRoute(current, seen);
    lines.push(
      "",
      `Current route "${current.route.name}" (${current.route.id}), stop by stop (stop id | city | arrive → depart | nights | arrive by | hotel | planned activities):`,
    );
    for (const s of current.stops) {
      const stay = s.stays.find((x) => x.status === "booked") ?? s.stays.find((x) => x.status === "chosen");
      const legsBooked = s.legs.filter((l) => l.status === "booked").length;
      lines.push(
        `${s.order + 1}. ${s.id} | ${s.city.name} (${s.city.code}, ${s.country.name}) | ${s.arrive} → ${s.depart} | ${s.nights} | ${s.arriveMode}${s.legs.length ? ` (${legsBooked}/${s.legs.length} tickets booked)` : ""} | ${stay ? `${stay.hotel.name} (${stay.status})` : "none yet"} | ${s.planned.length}`,
      );
    }
    const planned = current.stops.reduce((n, s) => n + s.planned.length, 0);
    const legs = current.stops.flatMap((s) => s.legs);
    const hotelsBooked = current.stops.filter((s) => s.stays.some((x) => x.status === "booked")).length;
    const issues = current.checks.checks.filter((c) => c.level !== "ok");
    lines.push(
      "",
      `Counts on the current route: ${plural(current.stops.length, "stop")}, ${plural(current.checks.totalNights, "night")}, back ${current.checks.returnDate}, ${plural(planned, "planned activity")}, ${legs.filter((l) => l.status === "booked").length}/${legs.length} tickets booked, ${hotelsBooked}/${current.stops.filter((s) => s.nights > 0).length} stops with a booked hotel. Estimated ${money(current.budget.perPerson.total)} CAD per person.`,
    );
    if (issues.length) {
      lines.push(`Checks needing attention: ${issues.map((c) => `${c.title} (${c.level})`).join("; ")}.`);
    }
  } else {
    lines.push("", "The trip has no routes yet.");
  }
  return lines.join("\n");
}

// --- compact tool results ------------------------------------------------------

export function trimRoute(view: RouteView, seen: Seen) {
  seeRoute(view, seen);
  return {
    route: { id: view.route.id, name: view.route.name, isCurrent: view.route.isCurrent, tags: view.route.tags },
    stops: view.stops.map((s) => ({
      id: s.id,
      n: s.order + 1,
      city: `${s.city.name} (${s.city.code})`,
      country: s.country.name,
      arrive: s.arrive,
      depart: s.depart,
      nights: s.nights,
      arriveBy: s.arriveMode,
      notes: s.notes,
      legs: s.legs.map((l) => ({
        id: l.id,
        mode: l.mode,
        from: l.from.name,
        to: l.to.name,
        number: l.number,
        operator: l.operator,
        departAt: l.departAt,
        arriveAt: l.arriveAt,
        status: l.status,
        cad: money(l.priceCad),
      })),
      hotels: s.stays.map((st) => ({ hotelId: st.hotel.id, name: st.hotel.name, area: st.hotel.areaName, status: st.status })),
      planned: s.planned.map((p) => ({ id: p.id, title: p.title, day: p.day, start: p.startTime, cad: money(p.costCad) })),
    })),
    checks: view.checks.checks.filter((c) => c.level !== "ok").map((c) => ({ level: c.level, title: c.title, detail: c.detail, stopId: c.stopId })),
    budgetPerPersonCad: { total: money(view.budget.perPerson.total), stay: money(view.budget.perPerson.stay), travel: money(view.budget.perPerson.travel), activities: money(view.budget.perPerson.activities) },
  };
}

/** Days of the itinerary, optionally only from..to (inclusive, YYYY-MM-DD). */
export function trimItinerary(itinerary: Itinerary, range: { from?: string; to?: string }, seen: Seen) {
  const days = itinerary.days.filter((d) => (!range.from || d.date >= range.from) && (!range.to || d.date <= range.to));
  for (const d of days) for (const it of d.items) seen.activity(it.activityId, it.title);
  for (const s of itinerary.stops) for (const it of [...s.unscheduled, ...s.needsNewDay]) seen.activity(it.activityId, it.title);
  return {
    days: days.map((d) => ({
      day: d.index,
      date: d.date,
      city: d.cityName,
      stopId: d.stopId,
      stopDay: d.stopDay,
      kind: d.kind,
      hotel: d.stay ? `${d.stay.name} (${d.stay.status})` : null,
      travel: d.legs.map((l) => ({ id: l.id, mode: l.mode, from: l.from.name, to: l.to.name, departAt: l.departAt, arriveAt: l.arriveAt, number: l.number, status: l.status })),
      items: d.items.map((it) => ({ id: it.activityId, title: it.title, start: it.startTime, mins: it.durationMin, clashes: it.conflicts.map((c) => c.message) })),
    })),
    notOnADay: itinerary.stops
      .filter((s) => s.unscheduled.length || s.needsNewDay.length)
      .map((s) => ({ stopId: s.stopId, city: s.cityName, activities: [...s.unscheduled, ...s.needsNewDay].map((it) => ({ id: it.activityId, title: it.title })) })),
  };
}

export interface ActivityFilter {
  cityCode?: string;
  tags?: string[];
  text?: string;
  planned?: boolean;
}

export const MAX_ACTIVITIES = 40;

export function trimActivities(list: LibraryActivity[], filter: ActivityFilter, routeId: string | null, seen: Seen) {
  const words = (filter.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const tags = (filter.tags ?? []).map((t) => t.toLowerCase());
  const isPlanned = (a: LibraryActivity) => a.plannedIn.some((p) => !routeId || p.routeId === routeId);
  const matches = list.filter((a) => {
    if (filter.cityCode && a.cityCode !== filter.cityCode) return false;
    if (tags.length && !tags.some((t) => a.tags.includes(t))) return false;
    if (filter.planned !== undefined && isPlanned(a) !== filter.planned) return false;
    if (words.length) {
      const hay = `${a.title} ${a.tags.join(" ")} ${a.address ?? ""} ${a.cityName}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  matches.sort((a, b) => b.votes - a.votes || a.title.localeCompare(b.title));
  const shown = matches.slice(0, MAX_ACTIVITIES);
  for (const a of shown) {
    seen.activity(a.id, a.title);
    seen.city(a.cityCode, a.cityName);
  }
  return {
    total: matches.length,
    shown: shown.length,
    activities: shown.map((a) => ({
      id: a.id,
      title: a.title,
      city: a.cityCode,
      tags: a.tags,
      cad: money(a.costCad),
      when: a.when,
      votes: a.votes || null,
      plannedOnCurrentRoute: isPlanned(a) || null,
      placed: a.lat != null && a.lon != null ? true : null,
      address: a.address,
      website: a.website,
    })),
  };
}

const bookingRow = (i: BookingItem, canSeePrivate: boolean) =>
  i.kind === "leg"
    ? {
        kind: "ticket",
        id: i.id,
        stopId: i.stopId,
        status: i.status,
        mode: i.mode,
        from: i.from.name,
        to: i.to.name,
        number: i.number,
        operator: i.operator,
        departAt: i.departAt,
        date: i.date,
        cadPerPerson: money(i.pricePerPersonCad),
        // Only present when the API returned them (editors); dropped otherwise as a second guard.
        ...(canSeePrivate && "bookingRef" in i ? { bookingRef: i.bookingRef, seat: i.seat } : {}),
      }
    : {
        kind: "hotel",
        id: i.id,
        hotelId: i.hotelId,
        stopId: i.stopId,
        status: i.status,
        hotel: i.hotelName,
        area: i.areaName,
        checkIn: i.checkIn,
        checkOut: i.checkOut,
        nights: i.nights,
        cadPerPerson: money(i.pricePerPersonCad),
      };

export function trimBookings(result: BookingsResult, seen: Seen) {
  const all = [...result.booked, ...result.pending];
  for (const i of all) {
    if (i.kind === "leg") seen.leg(i.id, `${i.number ? `${i.number} ` : ""}${i.mode} ${i.from.name} → ${i.to.name}`);
    else seen.hotel(i.hotelId, i.hotelName);
    seen.stop(i.stopId, `${i.cityName} (stop ${i.stopOrder + 1})`);
  }
  for (const t of result.toBook) {
    seen.stop(t.stopId, `${t.cityName} (stop ${t.stopOrder + 1})`);
    seen.city(t.cityCode, t.cityName);
  }
  return {
    route: result.route,
    canSeeBookingRefs: result.canSeePrivate,
    booked: result.booked.map((i) => bookingRow(i, result.canSeePrivate)),
    pickedNotBooked: result.pending.map((i) => bookingRow(i, result.canSeePrivate)),
    stillToBook: result.toBook.map((t) => ({
      stopId: t.stopId,
      city: `${t.cityName} (${t.cityCode})`,
      arrive: t.arrive,
      depart: t.depart,
      needsHotel: t.needsStay,
      needsTransport: t.needsTransport,
      arriveBy: t.arriveMode,
      from: t.fromCity?.name,
    })),
    totals: result.totals,
  };
}

export function trimPaths(result: PathResult, seen: Seen) {
  for (const c of result.cities) seen.city(c.code, c.name);
  return {
    found: result.found,
    by: result.by,
    railOnly: result.railOnly,
    cities: result.cities.map((c) => `${c.name} (${c.code})`),
    legs: result.legs.map((l) => ({ from: l.from, to: l.to, mode: l.mode, minutes: l.minutes, cad: money(l.costCad), source: l.source, asOf: l.asOf })),
    totalMinutes: result.totalMinutes,
    totalCad: money(result.totalCostCad),
  };
}

export function trimCompare(result: CompareResult, seen: Seen) {
  for (const a of [...result.activitiesGained, ...result.activitiesLost]) seen.activity(a.id, a.title);
  const summary = (r: CompareResult["a"]) => ({ id: r.id, name: r.name, stops: r.stopCount, nights: r.totalNights, back: r.returnDate, cadPerPerson: money(r.perPersonCad), checks: r.checksLevel });
  return {
    a: summary(result.a),
    b: summary(result.b),
    sharedCities: result.shared,
    onlyInA: result.onlyA,
    onlyInB: result.onlyB,
    nightsByCountry: result.nightsByCountry,
    plannedOnlyInB: result.activitiesGained.map((a) => ({ id: a.id, title: a.title })),
    plannedOnlyInA: result.activitiesLost.map((a) => ({ id: a.id, title: a.title })),
    budgetPerPerson: { a: money(result.budget.a.perPerson.total), b: money(result.budget.b.perPerson.total) },
  };
}

export const MAX_NEAR = 30;

/** Activities, hotels and stop cities with coordinates within `km` of a point, nearest first. */
export function nearby(
  point: { lat: number; lon: number },
  km: number,
  places: { activities: LibraryActivity[]; hotels: Hotel[]; stops: RouteView["stops"] },
  seen: Seen,
) {
  type Hit = { kind: "activity" | "hotel" | "city"; id: string; name: string; km: number; city?: string; extra?: Record<string, unknown> };
  const hits: Hit[] = [];
  const within = (lat: number | null | undefined, lon: number | null | undefined) => {
    if (lat == null || lon == null) return null;
    const d = distanceKm(point, { lat, lon });
    return d <= km ? Math.round(d * 10) / 10 : null;
  };
  for (const a of places.activities) {
    const d = within(a.lat, a.lon);
    if (d != null) hits.push({ kind: "activity", id: a.id, name: a.title, km: d, city: a.cityCode, extra: { tags: a.tags, address: a.address } });
  }
  for (const h of places.hotels) {
    const d = within(h.lat, h.lon);
    if (d != null) hits.push({ kind: "hotel", id: h.id, name: h.name, km: d, city: h.cityCode, extra: { area: h.areaName } });
  }
  const cities = new Map(places.stops.map((s) => [s.city.code, s.city]));
  for (const c of cities.values()) {
    const d = within(c.lat, c.lon);
    if (d != null) hits.push({ kind: "city", id: c.code, name: c.name, km: d });
  }
  hits.sort((a, b) => a.km - b.km);
  const shown = hits.slice(0, MAX_NEAR);
  for (const h of shown) {
    if (h.kind === "activity") seen.activity(h.id, h.name);
    else if (h.kind === "hotel") seen.hotel(h.id, h.name);
    else seen.city(h.id, h.name);
  }
  const unplaced = places.activities.filter((a) => a.lat == null || a.lon == null).length;
  return {
    total: hits.length,
    places: shown.map((h) => ({ kind: h.kind, id: h.id, name: h.name, km: h.km, city: h.city, ...h.extra })),
    activitiesWithoutAPin: unplaced,
  };
}

// --- references at the end of an answer ----------------------------------------

export const REFS_OPEN = "<refs>";
export const REFS_CLOSE = "</refs>";

/**
 * Answers end with <refs>{json}</refs>. This sits between the model's text
 * stream and the browser: text before the marker passes through, the marker
 * and what follows are held back. A chunk ending in a partial marker ("<re")
 * is held until the next chunk shows whether it is one.
 */
export class RefsSplitter {
  private pending = "";
  private captured: string | null = null;
  private shownText = "";

  /** Feeds one text delta; returns the part that is safe to show now. */
  push(delta: string): string {
    if (this.captured !== null) {
      this.captured += delta;
      return "";
    }
    const text = this.pending + delta;
    const at = text.indexOf(REFS_OPEN);
    if (at >= 0) {
      this.captured = text.slice(at + REFS_OPEN.length);
      this.pending = "";
      return this.show(text.slice(0, at));
    }
    // Hold back the longest suffix that could still become "<refs>".
    let hold = 0;
    for (let n = Math.min(REFS_OPEN.length - 1, text.length); n > 0; n--) {
      if (REFS_OPEN.startsWith(text.slice(-n))) {
        hold = n;
        break;
      }
    }
    this.pending = text.slice(text.length - hold);
    return this.show(text.slice(0, text.length - hold));
  }

  /** At the end of the answer: any held text, and the raw references JSON if there was one. */
  finish(): { tail: string; rawRefs: string | null } {
    const tail = this.show(this.pending);
    this.pending = "";
    if (this.captured === null) return { tail, rawRefs: null };
    const end = this.captured.indexOf(REFS_CLOSE);
    return { tail, rawRefs: (end >= 0 ? this.captured.slice(0, end) : this.captured).trim() };
  }

  /** Everything shown so far: the answer's text without the references. */
  get text() {
    return this.shownText;
  }

  private show(part: string) {
    this.shownText += part;
    return part;
  }
}

const idList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 80) : [];

/** Reads the references JSON; anything malformed counts as no references. */
export function parseRefs(raw: string | null): AssistantRefs {
  const empty: AssistantRefs = { stopIds: [], activityIds: [], legIds: [], hotelIds: [], cityCodes: [] };
  if (!raw) return empty;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (!data || typeof data !== "object") return empty;
    return {
      stopIds: idList(data.stopIds),
      activityIds: idList(data.activityIds),
      legIds: idList(data.legIds),
      hotelIds: idList(data.hotelIds),
      cityCodes: idList(data.cityCodes).map((c) => c.toUpperCase()),
    };
  } catch {
    return empty;
  }
}

/** One entry per page, in the order first cited. */
export function dedupeCitations(list: AssistantCitation[], max = 8): AssistantCitation[] {
  const seen = new Map<string, AssistantCitation>();
  for (const c of list) {
    if (!/^https?:\/\//.test(c.url) || seen.has(c.url)) continue;
    seen.set(c.url, { url: c.url, title: c.title, citedText: c.citedText ? c.citedText.slice(0, 300) : null });
  }
  return [...seen.values()].slice(0, max);
}

// --- thread history ----------------------------------------------------------

/** Messages of earlier questions sent back to the model. */
export const HISTORY_TURNS = 20;
/** Messages kept in a stored thread. */
export const STORED_TURNS = 100;

/** An answer's text plus what became of the changes it suggested, so the model knows on the next question. */
export function withSuggestions(turn: AssistantTurn): string {
  if (!turn.proposals?.length) return turn.text;
  const list = turn.proposals.map((p) => `"${p.summary}" (${p.status})`).join("; ");
  return `${turn.text}\n\n[Suggested changes: ${list}]`;
}

/**
 * Earlier questions and answers as plain text, the last `max` messages,
 * starting with a question. Tool calls and thinking from earlier answers are
 * not replayed: they stay in the request they were made in, which keeps the
 * history small and free of blocks tied to another request.
 */
export function historyMessages(turns: AssistantTurn[], max = HISTORY_TURNS): Anthropic.Beta.BetaMessageParam[] {
  const usable = turns.filter((t) => t.text.trim().length > 0);
  let recent = usable.slice(-max);
  while (recent.length && recent[0]!.role !== "user") recent = recent.slice(1);
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const t of recent) {
    const last = out.at(-1);
    const text = withSuggestions(t);
    // Keep roles alternating: merge two in a row (an answer that failed leaves a lone question).
    if (last && last.role === t.role) last.content = `${last.content as string}\n\n${text}`;
    else out.push({ role: t.role, content: text });
  }
  // The new question follows, so the history must end with an answer.
  if (out.at(-1)?.role === "user") out.pop();
  return out;
}

/** Most places a semantic search hands the model: it reads each one, so fewer and better than a list. */
export const MAX_SEARCH_HITS = 15;

/**
 * A semantic search result as the model reads it: why each place matched, where it is, whether the group planned
 * it. Records the ids so the answer can cite them. `mode` says whether meaning-based ranking was used.
 */
export function trimSearch(result: SearchResponse, routeId: string | null, seen: Seen) {
  const hits = result.hits.slice(0, MAX_SEARCH_HITS);
  for (const h of hits) {
    seen.activity(h.activity.id, h.activity.title);
    seen.city(h.activity.cityCode, h.activity.cityName);
  }
  return {
    mode: result.mode,
    note: result.notice?.message ?? null,
    total: result.hits.length,
    results: hits.map((h) => ({
      id: h.activity.id,
      title: h.activity.title,
      city: h.activity.cityCode,
      category: h.activity.category,
      tags: h.activity.tags,
      why: h.reason,
      distanceKm: h.distanceKm,
      votes: h.activity.votes || null,
      plannedOnCurrentRoute: h.activity.plannedIn.some((p) => !routeId || p.routeId === routeId) || null,
      address: h.activity.address,
      lat: h.activity.lat == null ? null : Math.round(h.activity.lat * 1e5) / 1e5,
      lon: h.activity.lon == null ? null : Math.round(h.activity.lon * 1e5) / 1e5,
      website: h.activity.website,
    })),
  };
}
