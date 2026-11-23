/**
 * Flight prices (data platform spec, Feature 6): daily price snapshots for
 * each flight leg, a history endpoint and a booking signal. Prices are
 * estimates taken from a provider's cache, per person, in CAD.
 */
import type { BookingSignal, CheapestDay, SignalVerdict } from "@trippr/rules";

/** Shown wherever a flight price is. */
export const FLIGHT_PRICE_DISCLAIMER = "Prices are estimates from recent searches, not live fares. Check the airline before you book.";

/** Shown instead of a source name when the data is invented for the demo. */
export const SAMPLE_DATA_NOTE = "Sample data for the demo, not real prices.";

export interface FlightPricePoint {
  /** The day the snapshot was taken, YYYY-MM-DD. */
  snapshotDate: string;
  /** Lowest price for the planned departure date, per person, CAD. */
  priceCad: number;
  airline: string | null;
  stops: number | null;
}

export interface FlightWindowDay {
  date: string;
  priceCad: number | null;
  airline: string | null;
  stops: number | null;
}

export interface FlightLatest {
  snapshotDate: string;
  /** Null when the provider had no price for the planned date that day (the window may still have some). */
  priceCad: number | null;
  airline: string | null;
  stops: number | null;
  /** The planned date and the days around it, as of the latest snapshot. */
  window: FlightWindowDay[];
  cheapest: CheapestDay | null;
}

export interface FlightDrop {
  /** Percent below the previous low. */
  pct: number;
  previousLowCad: number;
  priceCad: number;
  snapshotDate: string;
}

export type FlightPricesStatus =
  /** History is available (at least one snapshot). */
  | "ok"
  /** The feature is switched off or has no provider. */
  | "off"
  /** The leg is not a flight between two airports. */
  | "not_flight"
  /** The flight has left; the history is kept but there is no advice. */
  | "past"
  /** Nothing stored yet for this flight. */
  | "no_data";

export interface FlightPriceHistory {
  legId: string;
  status: FlightPricesStatus;
  provider: string | null;
  /** True when the prices are invented for the demo; the web labels them. */
  sample: boolean;
  origin: string | null;
  destination: string | null;
  departDate: string | null;
  /** The trip's group size, to turn per-person prices into a group total. */
  travellers: number;
  points: FlightPricePoint[];
  latest: FlightLatest | null;
  signal: BookingSignal | null;
  drop: FlightDrop | null;
  disclaimer: string;
}

export interface TripFlightItem {
  legId: string;
  stopId: string;
  cityName: string;
  origin: string;
  destination: string;
  departDate: string;
  latestCad: number | null;
  asOf: string | null;
  verdict: SignalVerdict | null;
  drop: FlightDrop | null;
}

/** The current route's flights with their latest price and any price-drop notice. */
export interface TripFlightPrices {
  enabled: boolean;
  sample: boolean;
  provider: string | null;
  items: TripFlightItem[];
  /** Flights whose latest snapshot fell at least the notice threshold below the previous low. */
  notices: TripFlightItem[];
  disclaimer: string;
}
