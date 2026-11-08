import type { RouteView } from "@trippr/contracts";
import { addDays, dayDate, isFixedDate, shortDate, whenLabel } from "@trippr/rules";

const MODE_LABEL: Record<string, string> = {
  flight: "Flight",
  hsr: "High-speed train",
  train: "Train",
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
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsDate = (iso: string) => iso.replace(/-/g, "");

/** Fold lines longer than 75 octets, as RFC 5545 requires. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), "utf8") > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

/** Calendar file: one all-day event per stop, plus one per fixed-date planned activity. */
export function routeToIcs(view: RouteView, stamp = new Date()): string {
  const dtstamp = `${stamp.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
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
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Trippr//Trip Graph//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${esc(`${view.trip.name}: ${view.route.name}`)}`,
    ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]),
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
