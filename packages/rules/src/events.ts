import { addDays, dayDate, shortDate, weekday, weekdayName, withinRange } from "./dates";
import type { When } from "./types";

export function isFixedDate(when: When | null | undefined): when is When {
  if (!when) return false;
  if ("on" in when) return typeof when.on === "string";
  if ("from" in when) return typeof when.from === "string" && typeof when.to === "string";
  return Array.isArray(when.weekdays) && when.weekdays.length > 0;
}

/**
 * Whether an activity's fixed date falls within a stop, counting both the
 * arrival day and the departure day as days you are in that city.
 */
export function eventFits(when: When, arrive: string, depart: string): boolean {
  if ("on" in when) return withinRange(when.on, arrive, depart);
  if ("from" in when) return when.from <= depart && when.to >= arrive;
  const wanted = new Set(when.weekdays);
  for (let d = arrive; d <= depart; d = addDays(d, 1)) {
    if (wanted.has(weekday(d))) return true;
  }
  return false;
}

export function whenLabel(when: When): string {
  if ("on" in when) return dayDate(when.on);
  if ("from" in when) return `${shortDate(when.from)} to ${shortDate(when.to)}`;
  return `Every ${when.weekdays.map(weekdayName).join(", ")}`;
}
