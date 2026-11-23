/**
 * The seam between Trippr and wherever flight prices come from. Everything
 * else (the daily job, the history endpoint, every test) talks to this
 * interface, so a provider can be swapped without touching them.
 */
export interface FlightQuery {
  /** IATA airport code. */
  origin: string;
  destination: string;
  /** Departure date, YYYY-MM-DD. */
  date: string;
  /** The day the snapshot is taken, YYYY-MM-DD. Real providers ignore it; the demo provider uses it to shape sample history. */
  asOf: string;
}

export interface FlightQuote {
  /** Lowest one-way price per person, in CAD. */
  priceCad: number;
  airline: string | null;
  /** 0 for non-stop. */
  stops: number | null;
}

export interface FlightPriceProvider {
  /** Stored with every snapshot ("travelpayouts", "demo"); history is kept per provider. */
  readonly id: string;
  /** True when the prices are invented (demo mode). The web labels them as sample data. */
  readonly sample: boolean;
  /** The cheapest price for the date, or null when the provider has none. One call is one request against the budget. */
  quote(query: FlightQuery): Promise<FlightQuote | null>;
}

/** The provider asked us to slow down. The job stops and tries again tomorrow. */
export class RateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = "RateLimitedError";
  }
}

/** The key was refused. Retrying will not help. */
export class ProviderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAuthError";
  }
}
