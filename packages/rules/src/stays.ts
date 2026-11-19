/**
 * Costs from hotels and legs. A chosen or booked hotel's price beats the
 * stop's rough stay estimate, and priced legs beat the rough travel estimate.
 */

/** Per person per night: a room price is shared by the people who sleep in it. */
export function perPersonNightly(
  price: number | null | undefined,
  basis: "room" | "person",
  sleeps: number | null | undefined,
): number | null {
  if (price == null) return null;
  if (basis === "person") return price;
  const people = sleeps && sleeps > 0 ? sleeps : 1;
  return Math.round((price / people) * 100) / 100;
}

export interface StopCostSources {
  stayCadPerNight?: number | null;
  arriveCostCad?: number | null;
  stays?: { status: string; perPersonCadPerNight?: number | null }[];
  legs?: { priceCad?: number | null }[];
}

export interface EffectiveStopCosts {
  stayCadPerNight: number | null;
  arriveCostCad: number | null;
  staySource: "hotel" | "estimate" | null;
  travelSource: "legs" | "estimate" | null;
}

export function effectiveStopCosts(stop: StopCostSources): EffectiveStopCosts {
  const chosen = (stop.stays ?? []).find(
    (s) => (s.status === "booked" || s.status === "chosen") && s.perPersonCadPerNight != null,
  );
  const priced = (stop.legs ?? []).filter((l) => l.priceCad != null);
  const stay = chosen ? chosen.perPersonCadPerNight! : (stop.stayCadPerNight ?? null);
  const travel = priced.length
    ? Math.round(priced.reduce((t, l) => t + (l.priceCad ?? 0), 0) * 100) / 100
    : (stop.arriveCostCad ?? null);
  return {
    stayCadPerNight: stay,
    arriveCostCad: travel,
    staySource: chosen ? "hotel" : stop.stayCadPerNight != null ? "estimate" : null,
    travelSource: priced.length ? "legs" : stop.arriveCostCad != null ? "estimate" : null,
  };
}
