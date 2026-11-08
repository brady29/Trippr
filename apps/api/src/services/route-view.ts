import type { Role, RouteSummary, RouteView, StopView } from "@trippr/contracts";
import { runChecks, type RuleStop } from "@trippr/rules";
import type { StoredRoute, StoredStop } from "../repositories";

type RuleInput = RuleStop & { stored: StoredStop };

/**
 * Cypher returns the graph shape; the rules module adds computed dates and
 * every check. This is the only place the two meet.
 */
export function buildRouteView(stored: StoredRoute, role: Role): RouteView {
  const input: RuleInput[] = stored.stops.map((s) => ({
    id: s.id,
    nights: s.nights,
    cityName: s.city.name,
    countryIso: s.country.iso,
    countryName: s.country.name,
    visaRule: s.country.visaRule ?? null,
    planned: s.planned,
    stored: s,
  }));
  const result = runChecks(stored.trip.startDate, input);

  const stops: StopView[] = result.schedule.stops.map(({ stop, arrive, depart }, i) => ({
    id: stop.id,
    order: i,
    nights: stop.nights,
    arriveMode: stop.stored.arriveMode,
    arriveNote: stop.stored.arriveNote,
    notes: stop.stored.notes,
    arrive,
    depart,
    city: {
      ...stop.stored.city,
      countryIso: stop.stored.country.iso,
      countryName: stop.stored.country.name,
    },
    country: stop.stored.country,
    planned: stop.stored.planned,
  }));

  const plannedCostCad = stored.stops.reduce(
    (total, s) => total + s.planned.reduce((t, a) => t + (a.costCad ?? 0), 0),
    0,
  );

  return {
    route: { ...stored.route, tripId: stored.trip.id },
    trip: stored.trip,
    role,
    stops,
    checks: {
      level: result.level,
      totalNights: result.schedule.totalNights,
      returnDate: result.schedule.returnDate,
      checks: result.checks,
      visa: result.visa,
      events: result.events,
    },
    plannedCostCad,
  };
}

export function summarize(view: RouteView): RouteSummary {
  const { tripId: _tripId, ...route } = view.route;
  return {
    ...route,
    stopCount: view.stops.length,
    totalNights: view.checks.totalNights,
    returnDate: view.checks.returnDate,
    checksLevel: view.checks.level,
    cities: view.stops.map((s) => s.city.name),
  };
}
