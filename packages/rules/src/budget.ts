/** The cost fields a budget needs from one stop. All amounts are CAD per person. */
export interface BudgetStop {
  id: string;
  nights: number;
  /** Accommodation per person per night; null when not estimated yet. */
  stayCadPerNight?: number | null;
  /** Per-person cost of getting to this stop from the previous one; null when not estimated yet. */
  arriveCostCad?: number | null;
  planned?: { costCad?: number | null }[];
}

export interface BudgetBreakdown {
  stay: number;
  travel: number;
  activities: number;
  total: number;
}

export interface Budget {
  travellers: number;
  perPerson: BudgetBreakdown;
  group: BudgetBreakdown;
  missing: {
    /** Nights at stops with no stay estimate. */
    stayNights: number;
    /** Stops with no estimate for getting there. */
    travelLegs: number;
    stayStopIds: string[];
    travelStopIds: string[];
  };
}

const cents = (n: number) => Math.round(n * 100) / 100;

function breakdown(stay: number, travel: number, activities: number): BudgetBreakdown {
  return { stay: cents(stay), travel: cents(travel), activities: cents(activities), total: cents(stay + travel + activities) };
}

/**
 * Per-person and group totals in CAD. Missing estimates count as zero and are
 * listed, so the totals are honest lower bounds rather than guesses.
 */
export function computeBudget(stops: readonly BudgetStop[], travellers = 1): Budget {
  const people = Number.isInteger(travellers) && travellers > 0 ? travellers : 1;
  let stay = 0;
  let travel = 0;
  let activities = 0;
  const stayStopIds: string[] = [];
  const travelStopIds: string[] = [];
  let stayNights = 0;
  for (const stop of stops) {
    if (stop.stayCadPerNight == null) {
      if (stop.nights > 0) {
        stayStopIds.push(stop.id);
        stayNights += stop.nights;
      }
    } else {
      stay += stop.stayCadPerNight * stop.nights;
    }
    if (stop.arriveCostCad == null) travelStopIds.push(stop.id);
    else travel += stop.arriveCostCad;
    for (const a of stop.planned ?? []) activities += a.costCad ?? 0;
  }
  return {
    travellers: people,
    perPerson: breakdown(stay, travel, activities),
    group: breakdown(stay * people, travel * people, activities * people),
    missing: { stayNights, travelLegs: travelStopIds.length, stayStopIds, travelStopIds },
  };
}
