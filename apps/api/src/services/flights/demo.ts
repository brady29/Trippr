import { daysBetween } from "@trippr/rules";
import type { FlightPriceProvider, FlightQuery, FlightQuote } from "./provider";

/** A small stable hash, so the same route and date always give the same sample price. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // A final mix, so strings that differ in one character give unrelated numbers.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 0..1, stable for the text. */
const unit = (text: string) => hash(text) / 0xffffffff;

const AIRLINES = ["Sample Air", "Demo Airways", "Example Jet"];

export interface DemoOptions {
  /**
   * On this snapshot day, about half of the routes dip well below their usual
   * price, so the demo shows the price-drop notice. Leave unset for no dips.
   */
  dipDay?: string;
}

/**
 * Invented prices for the demo and for tests: stable for a route, date and
 * snapshot day, with the shape of real fares (dearer very close to departure,
 * a little cheaper two months out, day-to-day noise and a few days with no
 * price). They carry no information about real fares and the app labels them
 * as sample data.
 */
export function createDemoProvider(options: DemoOptions = {}): FlightPriceProvider {
  return {
    id: "demo",
    sample: true,
    async quote(q: FlightQuery): Promise<FlightQuote | null> {
      const route = `${q.origin}-${q.destination}`;
      // A few days have no price, like real data, except the dip day (so the demo always has its newest price).
      if (options.dipDay !== q.asOf && hash(`${route}|${q.date}|${q.asOf}|gap`) % 23 === 0) return null;
      const base = 380 + Math.round(unit(route) * 1400);
      const lead = daysBetween(q.asOf, q.date);
      const leadFactor = lead < 0 ? 1 : lead <= 14 ? 1.25 : lead <= 30 ? 1.1 : lead <= 75 ? 0.92 : 1;
      const dateFactor = 0.9 + unit(`${route}|${q.date}`) * 0.22;
      const dayFactor = 0.94 + unit(`${route}|${q.date}|${q.asOf}`) * 0.12;
      let price = base * leadFactor * dateFactor * dayFactor;
      if (options.dipDay === q.asOf && hash(route) % 2 === 0) price = base * 0.55;
      const stops = hash(`${route}|stops`) % 3 === 0 ? 1 : 0;
      return {
        priceCad: Math.round(price),
        airline: AIRLINES[hash(`${route}|${q.date}`) % AIRLINES.length]!,
        stops,
      };
    },
  };
}
