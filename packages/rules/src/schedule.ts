import { addDays } from "./dates";
import type { RuleStop, Schedule } from "./types";

/**
 * Dates are computed, never stored: each stop arrives on the trip start plus
 * the nights of every stop before it. Reordering stops therefore needs no
 * data migration.
 */
export function computeSchedule<S extends RuleStop>(startDate: string, stops: readonly S[]): Schedule<S> {
  let cursor = startDate;
  let totalNights = 0;
  const scheduled = stops.map((stop) => {
    if (!Number.isInteger(stop.nights) || stop.nights < 0) {
      throw new RangeError(`Stop ${stop.id} has invalid nights: ${stop.nights}`);
    }
    const arrive = cursor;
    const depart = addDays(arrive, stop.nights);
    cursor = depart;
    totalNights += stop.nights;
    return { stop, arrive, depart };
  });
  return { startDate, stops: scheduled, totalNights, returnDate: cursor };
}
