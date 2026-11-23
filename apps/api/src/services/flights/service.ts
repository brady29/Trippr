import {
  FLIGHT_PRICE_DISCLAIMER,
  type FlightDrop,
  type FlightLatest,
  type FlightPriceHistory,
  type FlightPricesStatus,
  type FlightWindowDay,
  type RouteView,
  type TripFlightItem,
  type TripFlightPrices,
} from "@trippr/contracts";
import { bookingSignal, cheapestDay, daysBetween, priceDrop } from "@trippr/rules";
import type { Config } from "../../config";
import type { Repositories } from "../../repositories";
import { flightRouteKey, type FlightSnapshotRow } from "../../repositories/flights";
import { createDemoProvider } from "./demo";
import type { FlightPriceProvider } from "./provider";
import { createTravelpayouts } from "./travelpayouts";

/** A price-drop notice stays on the trip this many days. */
export const NOTICE_DAYS = 7;

/** One flight between two airports on a route, with the date its price is looked up for. */
export interface FlightHop {
  legId: string;
  stopId: string;
  cityName: string;
  origin: string;
  destination: string;
  /** The planned departure, YYYY-MM-DD. */
  departDate: string;
  status: string;
  travellers: number;
}

/**
 * Every flight between two airports on the route. The date is the leg's own
 * departure when it has one, otherwise the day the stop is reached.
 */
export function flightHops(view: RouteView): FlightHop[] {
  const travellers = view.trip.travellers ?? 1;
  const hops: FlightHop[] = [];
  for (const stop of view.stops) {
    for (const leg of stop.legs) {
      if (leg.mode !== "flight" || leg.from.kind !== "airport" || leg.to.kind !== "airport") continue;
      const origin = leg.from.id.toUpperCase();
      const destination = leg.to.id.toUpperCase();
      if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || origin === destination) continue;
      hops.push({
        legId: leg.id,
        stopId: stop.id,
        cityName: stop.city.name,
        origin,
        destination,
        departDate: leg.departAt?.slice(0, 10) ?? stop.arrive,
        status: leg.status,
        travellers,
      });
    }
  }
  return hops;
}

export const hopRouteKey = (provider: string, hop: Pick<FlightHop, "origin" | "destination" | "departDate">) =>
  flightRouteKey(provider, hop.origin, hop.destination, hop.departDate);

export interface FlightPricesOptions {
  config: Config;
  repos: Repositories;
  /** Overrides the provider chosen by the configuration (tests). */
  provider?: FlightPriceProvider | null;
  /** Today, YYYY-MM-DD (tests). */
  today?: () => string;
}

/** The provider the configuration asks for, or null when it is not set up (no key). */
export function resolveProvider(config: Config): FlightPriceProvider | null {
  if (config.FLIGHT_PRICES_PROVIDER === "demo") return createDemoProvider();
  if (config.TRAVELPAYOUTS_TOKEN) {
    return createTravelpayouts({ token: config.TRAVELPAYOUTS_TOKEN, minIntervalMs: config.FLIGHT_PRICES_MIN_INTERVAL_MS });
  }
  return null;
}

const utcToday = () => new Date().toISOString().slice(0, 10);

export type FlightPrices = ReturnType<typeof createFlightPrices>;

export function createFlightPrices({ config, repos, provider: override, today = utcToday }: FlightPricesOptions) {
  const provider = override === undefined ? resolveProvider(config) : override;
  const enabled = config.FLIGHT_PRICES_ENABLED && provider !== null;
  const sample = provider?.sample ?? false;

  const load = (hop: Pick<FlightHop, "origin" | "destination" | "departDate">) =>
    provider ? repos.flights.history(hopRouteKey(provider.id, hop)) : Promise.resolve([] as FlightSnapshotRow[]);

  function toDrop(row: FlightSnapshotRow | undefined, now: string): FlightDrop | null {
    if (!row || row.dropPct == null || row.priceCad == null || row.prevLowCad == null) return null;
    if (daysBetween(row.snapshotDate, now) > NOTICE_DAYS) return null;
    return { pct: row.dropPct, previousLowCad: row.prevLowCad, priceCad: row.priceCad, snapshotDate: row.snapshotDate };
  }

  const empty = (hop: Partial<FlightHop> & { legId: string }, status: FlightPricesStatus, travellers = 1): FlightPriceHistory => ({
    legId: hop.legId,
    status,
    provider: provider?.id ?? null,
    sample,
    origin: hop.origin ?? null,
    destination: hop.destination ?? null,
    departDate: hop.departDate ?? null,
    travellers,
    points: [],
    latest: null,
    signal: null,
    drop: null,
    disclaimer: FLIGHT_PRICE_DISCLAIMER,
  });

  return {
    provider,
    enabled,
    sample,

    /** The history, latest window, booking signal and any price-drop notice for one flight. */
    async history(hop: FlightHop | null, legId: string, travellers: number): Promise<FlightPriceHistory> {
      if (!enabled) return empty(hop ?? { legId }, "off", travellers);
      if (!hop) return empty({ legId }, "not_flight", travellers);
      const now = today();
      const rows = await load(hop);
      if (!rows.length) return { ...empty(hop, hop.departDate < now ? "past" : "no_data", hop.travellers) };
      const points = rows
        .filter((r): r is FlightSnapshotRow & { priceCad: number } => r.priceCad != null)
        .map((r) => ({ snapshotDate: r.snapshotDate, priceCad: r.priceCad, airline: r.airline, stops: r.stops }));
      const last = rows[rows.length - 1]!;
      const window: FlightWindowDay[] = last.window.map((w) => ({
        date: String(w.date),
        priceCad: w.priceCad ?? null,
        airline: w.airline ?? null,
        stops: w.stops ?? null,
      }));
      const latest: FlightLatest = {
        snapshotDate: last.snapshotDate,
        priceCad: last.priceCad,
        airline: last.airline,
        stops: last.stops,
        window,
        cheapest: cheapestDay(window, hop.departDate),
      };
      const past = hop.departDate < now;
      const signal =
        past || last.priceCad == null
          ? null
          : bookingSignal({ prices: points.map((p) => p.priceCad), daysToDeparture: daysBetween(last.snapshotDate, hop.departDate) });
      return {
        ...empty(hop, past ? "past" : "ok", hop.travellers),
        points,
        latest,
        signal,
        drop: past ? null : toDrop(last, now),
      };
    },

    /** The current route's flights with their latest price, signal and notices. */
    async tripSummary(view: RouteView | null): Promise<TripFlightPrices> {
      const base = { enabled, sample, provider: provider?.id ?? null, disclaimer: FLIGHT_PRICE_DISCLAIMER };
      if (!enabled || !view) return { ...base, items: [], notices: [] };
      const now = today();
      const hops = flightHops(view).filter((h) => h.departDate >= now);
      const items = await Promise.all(
        hops.map(async (hop): Promise<TripFlightItem> => {
          const rows = await load(hop);
          const last = rows[rows.length - 1];
          const priced = rows.filter((r) => r.priceCad != null).map((r) => r.priceCad as number);
          const verdict =
            last && last.priceCad != null
              ? bookingSignal({ prices: priced, daysToDeparture: daysBetween(last.snapshotDate, hop.departDate) }).verdict
              : null;
          return {
            legId: hop.legId,
            stopId: hop.stopId,
            cityName: hop.cityName,
            origin: hop.origin,
            destination: hop.destination,
            departDate: hop.departDate,
            latestCad: last?.priceCad ?? null,
            asOf: last?.snapshotDate ?? null,
            verdict,
            drop: toDrop(last, now),
          };
        }),
      );
      return { ...base, items, notices: items.filter((i) => i.drop) };
    },

    /**
     * Store one day's snapshot for a flight: the planned date's price (the
     * series the signal reads) and the days around it. Returns the drop when
     * the price is far enough under the previous low.
     */
    async recordSnapshot(hop: FlightHop, snapshotDate: string, window: FlightWindowDay[]): Promise<{ drop: FlightDrop | null }> {
      if (!provider) throw new Error("No flight price provider is configured");
      const planned = window.find((w) => w.date === hop.departDate) ?? null;
      const priceCad = planned?.priceCad ?? null;
      const earlier = (await load(hop)).filter((r) => r.snapshotDate < snapshotDate && r.priceCad != null);
      const previousLow = earlier.length ? Math.min(...earlier.map((r) => r.priceCad as number)) : null;
      const result = priceCad == null ? { dropped: false, pct: 0 } : priceDrop(previousLow, priceCad, config.FLIGHT_PRICES_DROP_PCT);
      await repos.flights.saveSnapshot({
        provider: provider.id,
        origin: hop.origin,
        destination: hop.destination,
        departDate: hop.departDate,
        snapshotDate,
        priceCad,
        airline: planned?.airline ?? null,
        stops: planned?.stops ?? null,
        window,
        sample: provider.sample,
        prevLowCad: result.dropped ? previousLow : null,
        dropPct: result.dropped ? result.pct : null,
      });
      return {
        drop:
          result.dropped && priceCad != null && previousLow != null
            ? { pct: result.pct, previousLowCad: previousLow, priceCad, snapshotDate }
            : null,
      };
    },
  };
}
