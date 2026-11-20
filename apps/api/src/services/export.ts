import type { RouteView } from "@trippr/contracts";
import {
  addDays,
  dayDate,
  instantOf,
  isFixedDate,
  localInstant,
  placeLinks,
  shortDate,
  whenLabel,
  type Itinerary,
  type PlaceLinkInput,
} from "@trippr/rules";

const MODE_LABEL: Record<string, string> = {
  flight: "Flight",
  hsr: "High-speed train",
  train: "Train",
  maglev: "Maglev",
  road: "Road",
  boat: "Boat",
};

/** Plain-text itinerary, for pasting into a group chat. */
export function routeToText(view: RouteView): string {
  const lines = [
    `${view.trip.name}: ${view.route.name}`,
    `${shortDate(view.trip.startDate)} to ${shortDate(view.checks.returnDate)}, ${view.checks.totalNights} nights`,
    "",
  ];
  for (const stop of view.stops) {
    lines.push(
      `${dayDate(stop.arrive)} to ${dayDate(stop.depart)}  ${stop.city.name}, ${stop.country.name} (${stop.nights} night${stop.nights === 1 ? "" : "s"})`,
    );
    lines.push(`  Arrive by ${MODE_LABEL[stop.arriveMode] ?? stop.arriveMode}${stop.arriveNote ? `: ${stop.arriveNote}` : ""}`);
    for (const a of stop.planned) {
      lines.push(`  - ${a.title}${isFixedDate(a.when) ? ` (${whenLabel(a.when)})` : ""}`);
    }
    if (stop.notes) lines.push(`  Notes: ${stop.notes}`);
  }
  const issues = view.checks.checks.filter((c) => c.level === "warn" || c.level === "error");
  if (issues.length) {
    lines.push("", "Checks:");
    for (const c of issues) lines.push(`  [${c.level}] ${c.title}: ${c.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

/** RFC 5545 text escaping. */
export const icsEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const esc = icsEscape;
/** A DATE value: 2027-05-19 becomes 20270519. */
export const icsDate = (iso: string) => iso.replace(/-/g, "");
/** A UTC DATE-TIME value: 20270519T000500Z. */
export const icsUtc = (ms: number) => `${new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;

/** Fold lines longer than 75 octets, as RFC 5545 requires, without splitting a character. */
export function icsFold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), "utf8") > 75) cut--;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

/** A whole calendar: header properties, then one VEVENT per event, folded and with CRLF line endings. */
export function icsCalendar(header: string[], events: string[][]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...header,
    ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]),
    "END:VCALENDAR",
  ];
  return `${lines.map(icsFold).join("\r\n")}\r\n`;
}

/** Calendar file: one all-day event per stop, plus one per fixed-date planned activity. */
export function routeToIcs(view: RouteView, stamp = new Date()): string {
  const dtstamp = icsUtc(stamp.getTime());
  const events: string[][] = [];
  for (const stop of view.stops) {
    if (stop.nights > 0) {
      events.push([
        `UID:${stop.id}@trippr`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;VALUE=DATE:${icsDate(stop.arrive)}`,
        `DTEND;VALUE=DATE:${icsDate(stop.depart)}`,
        `SUMMARY:${esc(`${stop.city.name} (${stop.nights} nights)`)}`,
        `LOCATION:${esc(`${stop.city.name}, ${stop.country.name}`)}`,
        `DESCRIPTION:${esc(
          [
            `Arrive by ${MODE_LABEL[stop.arriveMode] ?? stop.arriveMode}${stop.arriveNote ? `: ${stop.arriveNote}` : ""}`,
            ...stop.planned.map((a) => `- ${a.title}`),
          ].join("\n"),
        )}`,
      ]);
    }
    for (const a of stop.planned) {
      if (a.when && "on" in a.when) {
        events.push([
          `UID:${stop.id}-${a.id}@trippr`,
          `DTSTAMP:${dtstamp}`,
          `DTSTART;VALUE=DATE:${icsDate(a.when.on)}`,
          `DTEND;VALUE=DATE:${icsDate(addDays(a.when.on, 1))}`,
          `SUMMARY:${esc(a.title)}`,
          `LOCATION:${esc(stop.city.name)}`,
        ]);
      }
    }
  }
  return icsCalendar(
    ["PRODID:-//Trippr//Trip Graph//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${esc(`${view.trip.name}: ${view.route.name}`)}`],
    events,
  );
}

// --- calendar feed ---------------------------------------------------------------

/** Place details for an activity's links; the title and city come from the itinerary. */
export type FeedPlace = Omit<PlaceLinkInput, "title" | "cityName">;

export interface ItineraryIcsOptions {
  /** When the feed was built: DTSTAMP and LAST-MODIFIED. */
  stamp?: Date;
  /** Base URL of the web app, for links back to the trip. */
  webUrl: string;
  /**
   * Booking references and seats by leg id. Rendered only when includePrivate
   * is true; the caller decides that from the member's role and their choice.
   */
  legRefs?: Map<string, { bookingRef?: string | null; seat?: string | null }>;
  includePrivate?: boolean;
  /** Place fields by activity id (website, address, pin, a shared Maps link). */
  places?: Map<string, FeedPlace>;
}

const MINUTE = 60_000;
const timeOf = (t: string | null | undefined) => t?.match(/T(\d{2}:\d{2})(?::\d{2})?(Z|[+-]\d{2}:?\d{2})?$/) ?? null;
const localLabel = (t: string | null | undefined) => {
  const m = timeOf(t);
  if (!m) return null;
  return m[2] ? `${m[1]} (${m[2] === "Z" ? "UTC" : `UTC${m[2]}`})` : m[1]!;
};

/**
 * The subscribable calendar for a route: legs as timed events in UTC (from
 * their stored offsets), stays as all-day events from check-in to check-out,
 * and activities planned onto a day (timed in the city's time zone when they
 * have a start time, all-day otherwise). UIDs are stable, so a change updates
 * the event in the subscriber's calendar instead of adding another.
 */
export function itineraryToIcs(view: RouteView, itinerary: Itinerary, options: ItineraryIcsOptions): string {
  const stamp = icsUtc((options.stamp ?? new Date()).getTime());
  const tripUrl = `${options.webUrl.replace(/\/+$/, "")}/trips/${encodeURIComponent(view.trip.id)}/itinerary`;
  const stops = new Map(view.stops.map((s) => [s.id, s]));
  const legDurations = new Map(view.stops.flatMap((s) => s.legs.map((l) => [l.id, l.durationMin ?? null] as const)));
  const showPrivate = options.includePrivate === true && options.legRefs !== undefined;
  const head = (uid: string) => [`UID:${uid}@trippr`, `DTSTAMP:${stamp}`, `LAST-MODIFIED:${stamp}`];
  const allDay = (from: string, to: string) => [`DTSTART;VALUE=DATE:${icsDate(from)}`, `DTEND;VALUE=DATE:${icsDate(to)}`];
  const timed = (from: number, to: number) => [`DTSTART:${icsUtc(from)}`, `DTEND:${icsUtc(to)}`];
  const nightsLabel = (n: number) => `${n} night${n === 1 ? "" : "s"}`;
  const events: string[][] = [];

  for (const stop of view.stops) {
    if (stop.nights <= 0) continue;
    const stay = stop.stays.find((s) => s.status === "booked") ?? stop.stays.find((s) => s.status === "chosen");
    events.push([
      ...head(`stay-${stop.id}`),
      ...allDay(stop.arrive, stop.depart),
      `SUMMARY:${esc(stay ? `${stop.city.name}: ${stay.hotel.name}` : `${stop.city.name} (${nightsLabel(stop.nights)})`)}`,
      `LOCATION:${esc([stay?.hotel.name, stop.city.name, stop.country.name].filter(Boolean).join(", "))}`,
      `DESCRIPTION:${esc(
        [
          `${nightsLabel(stop.nights)} in ${stop.city.name}`,
          stay ? `Hotel: ${stay.hotel.name}${stay.status === "booked" ? " (booked)" : " (chosen, not booked yet)"}` : "No hotel chosen yet",
          ...(stay?.hotel.url ? [stay.hotel.url] : []),
          `Open in Trippr: ${tripUrl}`,
        ].join("\n"),
      )}`,
      `URL:${tripUrl}`,
      `STATUS:${stay?.status === "booked" ? "CONFIRMED" : "TENTATIVE"}`,
      "TRANSP:TRANSPARENT",
    ]);
  }

  for (const day of itinerary.days) {
    for (const leg of day.legs) {
      const depart = instantOf(leg.departAt);
      const arrive = instantOf(leg.arriveAt);
      const what = [MODE_LABEL[leg.mode] ?? leg.mode, [leg.operator, leg.number].filter(Boolean).join(" ")].filter(Boolean).join(" ");
      const ref = showPrivate ? options.legRefs!.get(leg.id) : undefined;
      const dep = localLabel(leg.departAt);
      const arr = localLabel(leg.arriveAt);
      let when: string[];
      if (depart != null) {
        const end = arrive != null && arrive > depart ? arrive : depart + (legDurations.get(leg.id) ?? 60) * MINUTE;
        when = timed(depart, end);
      } else {
        when = allDay(day.date, addDays(day.date, 1));
      }
      events.push([
        ...head(`leg-${leg.id}`),
        ...when,
        `SUMMARY:${esc(`${what}: ${leg.from.name} → ${leg.to.name}`)}`,
        `LOCATION:${esc(leg.from.name)}`,
        `DESCRIPTION:${esc(
          [
            ...(dep ? [`Departs ${dep} local time`] : []),
            ...(arr ? [`Arrives ${arr} local time`] : []),
            `Status: ${leg.status ?? "idea"}`,
            ...(ref?.bookingRef ? [`Booking reference: ${ref.bookingRef}`] : []),
            ...(ref?.seat ? [`Seat: ${ref.seat}`] : []),
            `Open in Trippr: ${tripUrl}`,
          ].join("\n"),
        )}`,
        `URL:${tripUrl}`,
        `STATUS:${leg.status === "booked" ? "CONFIRMED" : "TENTATIVE"}`,
      ]);
    }

    for (const item of day.items) {
      const stop = stops.get(item.stopId);
      const cityName = stop?.city.name ?? day.cityName ?? "";
      const place = options.places?.get(item.activityId);
      const start = item.startTime && day.tz ? localInstant(day.date, item.startTime, day.tz) : null;
      const links = placeLinks({ countryIso: stop?.country.iso ?? null, ...place, title: item.title, cityName });
      events.push([
        ...head(`act-${item.stopId}-${item.activityId}`),
        ...(start != null ? timed(start, start + (item.durationMin ?? 60) * MINUTE) : allDay(day.date, addDays(day.date, 1))),
        `SUMMARY:${esc(item.title)}`,
        `LOCATION:${esc(place?.address || [cityName, stop?.country.name].filter(Boolean).join(", "))}`,
        `DESCRIPTION:${esc(
          [
            ...item.conflicts.map((c) => `Heads up: ${c.message}`),
            ...links.map((l) => `${l.label}: ${l.url}`),
            `Open in Trippr: ${tripUrl}`,
          ].join("\n"),
        )}`,
        `URL:${tripUrl}`,
        ...(start == null ? ["TRANSP:TRANSPARENT"] : []),
      ]);
    }
  }

  return icsCalendar(
    [
      "PRODID:-//Trippr//Calendar feed//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${esc(`${view.trip.name} (Trippr)`)}`,
      `X-WR-CALDESC:${esc(`The current route of ${view.trip.name}, kept up to date by Trippr`)}`,
      "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
      "X-PUBLISHED-TTL:PT1H",
    ],
    events,
  );
}
