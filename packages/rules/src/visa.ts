import type { CountryEntry, RuleStop, Schedule, VisaSummary } from "./types";

/**
 * Group consecutive stops in the same country into one entry. A China stop,
 * then Hong Kong, then China again is two China entries, because Hong Kong
 * is a separate immigration zone.
 */
export function countryEntries<S extends RuleStop>(schedule: Schedule<S>): CountryEntry[] {
  const entries: CountryEntry[] = [];
  let current: CountryEntry | undefined;
  for (const { stop, arrive, depart } of schedule.stops) {
    if (current && current.countryIso === stop.countryIso) {
      current.stopIds.push(stop.id);
      current.cities.push(stop.cityName);
      current.depart = depart;
      current.nights += stop.nights;
      current.days = current.nights + 1;
      continue;
    }
    current = {
      countryIso: stop.countryIso,
      countryName: stop.countryName,
      stopIds: [stop.id],
      cities: [stop.cityName],
      arrive,
      depart,
      nights: stop.nights,
      days: stop.nights + 1,
    };
    entries.push(current);
  }
  return entries;
}

/** Entries for every country that has a visa-free rule, flagged against its limit. */
export function visaSummaries<S extends RuleStop>(schedule: Schedule<S>): VisaSummary[] {
  const rules = new Map<string, { name: string; limit: number; until?: string }>();
  for (const { stop } of schedule.stops) {
    const rule = stop.visaRule;
    if (rule && Number.isFinite(rule.visaFreeDays) && !rules.has(stop.countryIso)) {
      rules.set(stop.countryIso, { name: stop.countryName, limit: rule.visaFreeDays, until: rule.entriesUntil });
    }
  }
  const entries = countryEntries(schedule);
  return [...rules].map(([iso, rule]) => ({
    countryIso: iso,
    countryName: rule.name,
    limitDays: rule.limit,
    ...(rule.until ? { entriesUntil: rule.until } : {}),
    entries: entries
      .filter((e) => e.countryIso === iso)
      .map((e) => ({ ...e, overLimit: e.days > rule.limit })),
  }));
}
