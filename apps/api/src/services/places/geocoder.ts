/**
 * Finds a point for a place name. The first implementation is OpenStreetMap's
 * public Nominatim service, whose data may be stored and shown on our own map
 * (with the OSM attribution the map tiles already show). Its usage policy:
 * at most one request a second, a User-Agent naming the app, results cached,
 * no bulk jobs. https://operations.osmfoundation.org/policies/nominatim/
 * Only place and city names are sent, never anything about members.
 */

export interface GeoQuery {
  text: string;
  /** Biases results towards the activity's city. */
  near?: { lat: number; lon: number };
  /** ISO 3166-1 alpha-2; limits results to that country. */
  countryIso?: string | null;
}

export interface GeoResult {
  lat: number;
  lon: number;
  address: string | null;
  osmId: string | null;
}

export interface Geocoder {
  name: string;
  search(query: GeoQuery): Promise<GeoResult | null>;
}

export const noGeocoder: Geocoder = { name: "none", search: async () => null };

/** Runs tasks one at a time with at least `gapMs` between their starts. */
export function spacedQueue(gapMs: number, now = () => Date.now(), sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  let tail: Promise<unknown> = Promise.resolve();
  let last = -Infinity;
  return function run<T>(task: () => Promise<T>): Promise<T> {
    const next = tail.then(async () => {
      const wait = last + gapMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
      return task();
    });
    tail = next.catch(() => undefined);
    return next;
  };
}

type NominatimHit = { lat?: string; lon?: string; display_name?: string; osm_type?: string; osm_id?: number | string };

export function createNominatim(options: {
  userAgent: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Geocoder {
  const base = options.baseUrl ?? "https://nominatim.openstreetmap.org";
  const doFetch = options.fetchImpl ?? fetch;
  const queue = spacedQueue(1100);
  return {
    name: "nominatim",
    search(query) {
      return queue(async () => {
        const params = new URLSearchParams({ q: query.text, format: "jsonv2", limit: "1", "accept-language": "en" });
        if (query.countryIso) params.set("countrycodes", query.countryIso.toLowerCase());
        if (query.near) {
          // About 60 km around the city: a preference, not a hard limit (bounded is off).
          const d = 0.6;
          const { lat, lon } = query.near;
          params.set("viewbox", [lon - d, lat + d, lon + d, lat - d].map((n) => n.toFixed(4)).join(","));
        }
        try {
          const res = await doFetch(`${base}/search?${params.toString()}`, {
            headers: { "user-agent": options.userAgent, accept: "application/json" },
            signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
          });
          if (!res.ok) return null;
          const [hit] = (await res.json()) as NominatimHit[];
          const lat = Number(hit?.lat);
          const lon = Number(hit?.lon);
          if (!hit || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
          return {
            lat,
            lon,
            address: hit.display_name?.slice(0, 300) ?? null,
            osmId: hit.osm_type && hit.osm_id != null ? `${hit.osm_type}/${hit.osm_id}` : null,
          };
        } catch {
          return null;
        }
      });
    },
  };
}
