import { addDays } from "./dates";

/**
 * "Book now or wait" for one flight hop, from its own price history.
 *
 * This is an estimate from a small number of cached prices, not a forecast:
 * every result carries a plain-language reason and a confidence so the app
 * can say how much weight to give it. Pure and deterministic.
 */

export type SignalVerdict = "buy" | "wait" | "watch";
export type SignalConfidence = "low" | "medium" | "high";
export type PriceTrend = "falling" | "rising" | "flat";

export interface BookingSignal {
  verdict: SignalVerdict;
  confidence: SignalConfidence;
  /** One or two plain sentences, safe to show as is. */
  reason: string;
  /** Prices used, including the current one. */
  samples: number;
  /** Share of earlier prices that were higher than the current one, 0 to 100; null without history. */
  lowerThanPct: number | null;
  lowestCad: number | null;
  medianCad: number | null;
  highestCad: number | null;
  /** Recent prices against the ones before them; null with fewer than 10 prices. */
  trend: PriceTrend | null;
  daysToDeparture: number;
}

/** Earlier snapshots needed before the signal says anything stronger than "watch". */
export const MIN_HISTORY = 5;
/** At or below this many days out, fares rarely fall. */
export const CLOSE_IN_DAYS = 21;
/** At or beyond this many days out, an expensive fare has time to drop. */
export const FAR_OUT_DAYS = 35;
/** Share of earlier prices the current one must beat to count as cheap (or, mirrored, expensive). */
export const CHEAP_SHARE = 0.75;
export const TREND_THRESHOLD = 0.03;

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / xs.length;

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Recent week of prices against the week before it. Needs at least 10 prices. */
export function priceTrend(prices: number[]): PriceTrend | null {
  if (prices.length < 10) return null;
  const size = Math.min(7, Math.floor(prices.length / 2));
  const recent = mean(prices.slice(-size));
  const before = mean(prices.slice(-2 * size, -size));
  if (before <= 0) return null;
  const change = (recent - before) / before;
  return change <= -TREND_THRESHOLD ? "falling" : change >= TREND_THRESHOLD ? "rising" : "flat";
}

function sampleConfidence(n: number): SignalConfidence {
  return n >= 21 ? "high" : n >= 10 ? "medium" : "low";
}

const cap = (a: SignalConfidence, max: SignalConfidence): SignalConfidence => {
  const order: SignalConfidence[] = ["low", "medium", "high"];
  return order[Math.min(order.indexOf(a), order.indexOf(max))]!;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * @param prices Lowest price in CAD for the planned departure date at each
 *   snapshot, oldest first. The last one is the current price.
 * @param daysToDeparture Days from the latest snapshot to the departure date.
 */
export function bookingSignal(input: { prices: number[]; daysToDeparture: number }): BookingSignal {
  const prices = input.prices.filter((p) => Number.isFinite(p) && p > 0);
  const days = Math.round(input.daysToDeparture);
  const n = prices.length;
  const sorted = [...prices].sort((a, b) => a - b);
  const base = {
    samples: n,
    lowerThanPct: null as number | null,
    lowestCad: n ? sorted[0]! : null,
    medianCad: n ? median(sorted) : null,
    highestCad: n ? sorted[n - 1]! : null,
    trend: priceTrend(prices),
    daysToDeparture: days,
  };

  if (n === 0) {
    return { ...base, verdict: "watch", confidence: "low", reason: "No prices yet. Check back after the next daily update." };
  }
  if (days < 0) {
    return { ...base, verdict: "watch", confidence: "low", reason: "This flight has already left." };
  }

  const current = prices[n - 1]!;
  const past = prices.slice(0, -1);
  if (past.length < MIN_HISTORY) {
    const have = plural(past.length + 1, "day");
    return {
      ...base,
      verdict: "watch",
      confidence: "low",
      reason: `We have only ${have} of prices for this flight, which is too few to say. Check back in a few days.`,
    };
  }

  const higher = past.filter((p) => p > current).length;
  const share = higher / past.length;
  const lowerThanPct = Math.round(share * 100);
  const withShare = { ...base, lowerThanPct };
  const conf = sampleConfidence(n);
  const trend = base.trend;
  const closeIn = days <= CLOSE_IN_DAYS;
  const farOut = days >= FAR_OUT_DAYS;

  if (share >= CHEAP_SHARE) {
    return {
      ...withShare,
      verdict: "buy",
      confidence: conf,
      reason: `Lower than ${lowerThanPct}% of the prices we've seen for this flight. This is near its best.`,
    };
  }

  if (share <= 1 - CHEAP_SHARE) {
    const highPct = Math.round((1 - share) * 100);
    if (closeIn) {
      return {
        ...withShare,
        verdict: "buy",
        confidence: "low",
        reason: `Higher than ${highPct}% of the prices we've seen, but the flight is only ${plural(days, "day")} away and fares rarely fall this late.`,
      };
    }
    if (farOut || trend === "falling") {
      return {
        ...withShare,
        verdict: "wait",
        confidence: cap(conf, farOut ? "medium" : "low"),
        reason: `Higher than ${highPct}% of the prices we've seen, and there are ${plural(days, "day")} left to find a better fare${trend === "falling" ? "; recent prices are falling" : ""}.`,
      };
    }
    return {
      ...withShare,
      verdict: "watch",
      confidence: cap(conf, "medium"),
      reason: `Higher than ${highPct}% of the prices we've seen. Keep watching for a drop before booking.`,
    };
  }

  // In the middle of its own range: timing and direction decide.
  if (trend === "falling" && !closeIn) {
    return {
      ...withShare,
      verdict: "wait",
      confidence: cap(conf, "medium"),
      reason: "A middling price that has been falling over the past week. Waiting a little may pay off.",
    };
  }
  if (closeIn) {
    return {
      ...withShare,
      verdict: "buy",
      confidence: cap(conf, "medium"),
      reason: `A middling price with ${plural(days, "day")} to go. Fares usually climb as departure gets close.`,
    };
  }
  if (trend === "rising" && days <= 6 * 7) {
    return {
      ...withShare,
      verdict: "buy",
      confidence: cap(conf, "medium"),
      reason: "A middling price that has been rising over the past week, with departure getting nearer.",
    };
  }
  return {
    ...withShare,
    verdict: "watch",
    confidence: cap(conf, "medium"),
    reason: `About in the middle of the prices we've seen (lower than ${lowerThanPct}% of them). No strong reason to act yet.`,
  };
}

export interface PriceDrop {
  dropped: boolean;
  /** How far below the previous low the new price is, in percent (negative when higher). */
  pct: number;
}

/** A snapshot at least `thresholdPct` below the previous low is worth a notice. */
export function priceDrop(previousLowCad: number | null | undefined, currentCad: number, thresholdPct = 15): PriceDrop {
  if (previousLowCad == null || !(previousLowCad > 0) || !(currentCad > 0)) return { dropped: false, pct: 0 };
  const pct = round1(((previousLowCad - currentCad) / previousLowCad) * 100);
  return { dropped: pct >= thresholdPct, pct };
}

export interface WindowPrice {
  date: string;
  priceCad: number | null;
  airline?: string | null;
  stops?: number | null;
}

/** The dates searched around the planned one, oldest first. */
export function windowDates(plannedDate: string, days: number): string[] {
  const out: string[] = [];
  for (let d = -days; d <= days; d++) out.push(addDays(plannedDate, d));
  return out;
}

export interface CheapestDay {
  date: string;
  priceCad: number;
  /** Compared with the planned date's price; positive when this day is cheaper. */
  savingCad: number | null;
  isPlanned: boolean;
}

/** The cheapest day in the window; a tie goes to the planned day, then the earlier date. */
export function cheapestDay(window: WindowPrice[], plannedDate: string): CheapestDay | null {
  const priced = window.filter((w): w is WindowPrice & { priceCad: number } => w.priceCad != null && w.priceCad > 0);
  if (!priced.length) return null;
  const planned = priced.find((w) => w.date === plannedDate) ?? null;
  const sorted = [...priced].sort(
    (a, b) => a.priceCad - b.priceCad || Number(b.date === plannedDate) - Number(a.date === plannedDate) || a.date.localeCompare(b.date),
  );
  const winner = sorted[0]!;
  return {
    date: winner.date,
    priceCad: winner.priceCad,
    savingCad: planned ? Math.round((planned.priceCad - winner.priceCad) * 100) / 100 : null,
    isPlanned: winner.date === plannedDate,
  };
}
