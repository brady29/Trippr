/**
 * Date-only arithmetic on YYYY-MM-DD strings. Everything runs in UTC so a
 * traveller's time zone can never shift a stop by a day.
 */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function parseDate(iso: string): Date {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new RangeError(`Expected a YYYY-MM-DD date, got "${iso}"`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    throw new RangeError(`"${iso}" is not a real calendar date`);
  }
  return date;
}

export function isIsoDate(value: string): boolean {
  try {
    parseDate(value);
    return true;
  } catch {
    return false;
  }
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return formatDate(new Date(parseDate(iso).getTime() + days * DAY_MS));
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday, matching JavaScript's getUTCDay. */
export function weekday(iso: string): number {
  return parseDate(iso).getUTCDay();
}

/** Inclusive range check on ISO dates (string comparison is safe for YYYY-MM-DD). */
export function withinRange(iso: string, from: string, to: string): boolean {
  return iso >= from && iso <= to;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "May 14" */
export function shortDate(iso: string): string {
  const d = parseDate(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "Thu May 13" */
export function dayDate(iso: string): string {
  return `${WEEKDAYS[weekday(iso)]} ${shortDate(iso)}`;
}

export function weekdayName(day: number): string {
  return WEEKDAYS[day] ?? `day ${day}`;
}
