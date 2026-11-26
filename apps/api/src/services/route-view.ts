import type { Leg, Role, RouteSummary, RouteView, StopStay, StopView } from "@trippr/contracts";
import { computeBudget, effectiveStopCosts, perPersonNightly, runChecks, type RuleLeg, type RuleStop } from "@trippr/rules";
import type { StoredRoute, StoredStop } from "../repositories";
import type { StoredLeg, StoredStay } from "../repositories/routes";

type RuleInput = RuleStop & { stored: StoredStop };

const MODE_WORD: Record<string, string> = {
  flight: "Flight",
  hsr: "High-speed train",
  train: "Train",
  maglev: "Maglev",
  boat: "Boat",
  road: "Road",
};

/** The shared view of a leg: never the booking reference or seat. */
export function publicLeg(l: StoredLeg): Leg {
  const { bookingRef: _ref, seat: _seat, ...rest } = l;
  return rest;
}

export function stopStay(s: StoredStay): StopStay {
  return {
    status: s.status,
    rooms: s.rooms,
    hotel: s.hotel,
    perPersonCadPerNight: perPersonNightly(s.hotel.priceCadPerNight, s.hotel.priceBasis, s.hotel.sleeps),
    ...(s.status === "booked" ? { arrive: s.arrive, depart: s.depart, freeCancelUntil: s.freeCancelUntil } : {}),
  };
}

const legLabel = (l: StoredLeg) =>
  [MODE_WORD[l.mode] ?? l.mode, [l.operator, l.number].filter(Boolean).join(" ")].filter(Boolean).join(" ");

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
    legs: s.legs.map((l) => ({ id: l.id, departAt: l.departAt, arriveAt: l.arriveAt, status: l.status, label: legLabel(l), freeCancelUntil: l.freeCancelUntil })),
    stays: s.stays.map((st) => ({
      hotelId: st.hotel.id,
      name: st.hotel.name,
      status: st.status,
      arrive: st.arrive,
      depart: st.depart,
      freeCancelUntil: st.freeCancelUntil,
    })),
    stored: s,
  }));
  const home = stored.homeLegs.map((l) => ({ id: l.id, departAt: l.departAt, arriveAt: l.arriveAt, status: l.status, label: legLabel(l), freeCancelUntil: l.freeCancelUntil }));
  const result = runChecks(stored.trip.startDate, input, home, stored.trip.latestReturn);

  const stops: StopView[] = result.schedule.stops.map(({ stop, arrive, depart }, i) => ({
    id: stop.id,
    order: i,
    nights: stop.nights,
    arriveMode: stop.stored.arriveMode,
    arriveNote: stop.stored.arriveNote,
    notes: stop.stored.notes,
    stayCadPerNight: stop.stored.stayCadPerNight,
    arriveCostCad: stop.stored.arriveCostCad,
    arrive,
    depart,
    city: {
      ...stop.stored.city,
      countryIso: stop.stored.country.iso,
      countryName: stop.stored.country.name,
    },
    country: stop.stored.country,
    planned: stop.stored.planned,
    legs: stop.stored.legs.map(publicLeg),
    stays: stop.stored.stays.map(stopStay),
  }));

  // A chosen or booked hotel's price, and priced legs, beat the rough estimates.
  const budget = computeBudget(
    stops.map((s) => ({ id: s.id, nights: s.nights, planned: s.planned, ...effectiveStopCosts(s) })),
    stored.trip.travellers ?? 1,
  );

  return {
    route: { ...stored.route, tripId: stored.trip.id },
    trip: stored.trip,
    role,
    stops,
    homeLegs: stored.homeLegs.map(publicLeg),
    checks: {
      level: result.level,
      totalNights: result.schedule.totalNights,
      returnDate: result.schedule.returnDate,
      checks: result.checks,
      visa: result.visa,
      events: result.events,
    },
    plannedCostCad: budget.perPerson.activities,
    budget,
  };
}

/** A built view back in the rules module's shape, for checks that run on what the member sees (the assistant). */
export function ruleStopsOfView(view: RouteView): RuleStop[] {
  return view.stops.map((s) => ({
    id: s.id,
    nights: s.nights,
    cityName: s.city.name,
    countryIso: s.country.iso,
    countryName: s.country.name,
    visaRule: s.country.visaRule ?? null,
    planned: s.planned,
    legs: s.legs.map((l) => ({ id: l.id, departAt: l.departAt, arriveAt: l.arriveAt, status: l.status, label: publicLegLabel(l), freeCancelUntil: l.freeCancelUntil ?? null })),
    stays: s.stays.map((st) => ({ hotelId: st.hotel.id, name: st.hotel.name, status: st.status, arrive: st.arrive ?? null, depart: st.depart ?? null, freeCancelUntil: st.freeCancelUntil ?? null })),
  }));
}

export function ruleHomeOfView(view: RouteView): RuleLeg[] {
  return (view.homeLegs ?? []).map((l) => ({ id: l.id, departAt: l.departAt, arriveAt: l.arriveAt, status: l.status, label: publicLegLabel(l), freeCancelUntil: l.freeCancelUntil ?? null }));
}

const publicLegLabel = (l: Leg) => [MODE_WORD[l.mode] ?? l.mode, [l.operator, l.number].filter(Boolean).join(" ")].filter(Boolean).join(" ");

export function summarize(view: RouteView): RouteSummary {
  const { tripId: _tripId, ...route } = view.route;
  return {
    ...route,
    stopCount: view.stops.length,
    totalNights: view.checks.totalNights,
    returnDate: view.checks.returnDate,
    checksLevel: view.checks.level,
    cities: view.stops.map((s) => s.city.name),
    perPersonCad: view.budget.perPerson.total,
  };
}
