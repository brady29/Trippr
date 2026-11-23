import { ProviderAuthError, RateLimitedError, type FlightPriceProvider, type FlightQuery, type FlightQuote } from "./provider";

const BASE_URL = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates";

export interface TravelpayoutsOptions {
  /** The Data API token (a secret: from the environment, never from code). */
  token: string;
  /** Minimum gap between requests; the documented limit is 600 a minute. */
  minIntervalMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseUrl?: string;
  timeoutMs?: number;
}

interface Offer {
  price?: unknown;
  airline?: unknown;
  transfers?: unknown;
  departure_at?: unknown;
}

const asNumber = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Travelpayouts / Aviasales Data API: the cheapest cached price people found
 * for a route and day in the last two days or so. Not a live quote; some
 * routes and dates have none. See docs/flight-prices-provider-spike.md.
 */
export function createTravelpayouts(options: TravelpayoutsOptions): FlightPriceProvider {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const minInterval = options.minIntervalMs ?? 250;
  let lastAt = Number.NEGATIVE_INFINITY;

  return {
    id: "travelpayouts",
    sample: false,
    async quote(q: FlightQuery): Promise<FlightQuote | null> {
      // Keep a minimum gap between requests.
      const wait = lastAt + minInterval - now();
      if (wait > 0) await sleep(wait);
      lastAt = now();

      const url = new URL(options.baseUrl ?? BASE_URL);
      url.searchParams.set("origin", q.origin);
      url.searchParams.set("destination", q.destination);
      url.searchParams.set("departure_at", q.date);
      url.searchParams.set("one_way", "true");
      url.searchParams.set("currency", "cad");
      url.searchParams.set("sorting", "price");
      url.searchParams.set("unique", "false");
      url.searchParams.set("limit", "30");

      const res = await doFetch(url, {
        headers: { "X-Access-Token": options.token, accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      if (res.status === 429) {
        throw new RateLimitedError("Travelpayouts rate limit reached", asNumber(res.headers.get("retry-after")));
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderAuthError(`Travelpayouts refused the token (HTTP ${res.status})`);
      }
      if (!res.ok) throw new Error(`Travelpayouts answered HTTP ${res.status}`);

      const body = (await res.json()) as { success?: unknown; data?: unknown; currency?: unknown };
      // Never show another currency as CAD.
      if (typeof body.currency === "string" && body.currency.toLowerCase() !== "cad") {
        throw new Error(`Travelpayouts answered in ${body.currency}, not CAD`);
      }
      if (body.success === false || !Array.isArray(body.data)) return null;

      let best: { price: number; offer: Offer } | null = null;
      for (const raw of body.data as Offer[]) {
        const price = asNumber(raw?.price);
        if (price == null || price <= 0) continue;
        // The date filter should already hold; ignore any offer on another day.
        if (typeof raw.departure_at === "string" && !raw.departure_at.startsWith(q.date)) continue;
        if (!best || price < best.price) best = { price, offer: raw };
      }
      if (!best) return null;
      const stops = asNumber(best.offer.transfers);
      return {
        priceCad: Math.round(best.price * 100) / 100,
        airline: typeof best.offer.airline === "string" && best.offer.airline ? best.offer.airline : null,
        stops: stops == null ? null : Math.max(0, Math.round(stops)),
      };
    },
  };
}
