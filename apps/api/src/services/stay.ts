import {
  coverageNote,
  DEFAULT_STAY_ATTRIBUTION,
  STAY_PART_KEYS,
  STAY_PART_LABELS,
  type AreaStay,
  type DataStayView,
  type HotelSuggestion,
  type StayCell,
  type StayCoverage,
} from "@trippr/contracts";
import type { StayLoadView, StoredHotel, StoredMarket } from "../repositories/stay";
import type { StoredAreaStay } from "./catalogue/stay";

/** Answers for the stay routes, kept free of Fastify so they can be tested on their own. */

export function coverageOf(load: StayLoadView | null): StayCoverage | null {
  return load
    ? { coveredCities: load.coverageCities, trippCities: load.trippCities, note: coverageNote(load.coverageCities, load.trippCities) }
    : null;
}

/** One honest sentence about what the card can and cannot say. */
export function stayNote(card: Pick<AreaStay, "availability" | "cityCovered" | "cityName" | "snapshotDate" | "market" | "coverage">): string {
  const coverage = card.coverage ? ` ${card.coverage.note}.` : "";
  switch (card.availability) {
    case "market": {
      const n = card.market?.listings ?? 0;
      const low = card.market?.lowSample ? " Few listings, so treat the prices as rough." : "";
      return `From ${n} Inside Airbnb listing${n === 1 ? "" : "s"}${card.snapshotDate ? ` in the ${card.snapshotDate} snapshot` : ""}. Asking prices in CAD, not quotes.${low}`;
    }
    case "places":
      return card.cityCovered
        ? "Too few Inside Airbnb listings in this area for prices, so the score comes from location and nearby places only."
        : `No stay data for ${card.cityName}: there is no price data, so the score comes from location and nearby places only.${coverage}`;
    default:
      return card.cityCovered
        ? `No stay numbers for this area: it is not one of the areas the data run measures. The ${card.cityName} figures are on the map layer.`
        : `No stay data for ${card.cityName}.${coverage}`;
  }
}

export interface AreaCardInput {
  id: string;
  cityCode: string;
  cityName: string;
  radiusKm: number | null;
  stay: Record<string, unknown> | null;
  bundleDate: string | null;
  hotelSuggestions: number;
}

/** The GET /areas/:id/stay answer from the stored card, the city's market and the latest stay load. */
export function buildAreaStay(
  area: AreaCardInput,
  options: { load: StayLoadView | null; cityCovered: boolean; attribution?: string | null },
): AreaStay {
  const stored = area.stay as StoredAreaStay | null;
  const coverage = coverageOf(options.load);
  const base: Omit<AreaStay, "note" | "attribution"> = stored
    ? {
        areaId: area.id,
        cityCode: area.cityCode,
        cityName: area.cityName,
        availability: stored.availability,
        cityCovered: options.cityCovered || stored.cityCovered,
        score: stored.score,
        parts: stored.parts,
        weightCoverage: stored.weightCoverage,
        explanation: stored.explanation,
        price: stored.price,
        market: stored.market,
        location: stored.location,
        hotelSuggestions: area.hotelSuggestions,
        snapshotDate: stored.snapshotDate,
        bundleDate: area.bundleDate,
        coverage,
      }
    : {
        areaId: area.id,
        cityCode: area.cityCode,
        cityName: area.cityName,
        availability: "none",
        cityCovered: options.cityCovered,
        score: null,
        parts: STAY_PART_KEYS.map((key) => ({ key, label: STAY_PART_LABELS[key], score: null, weight: 0 })),
        weightCoverage: null,
        explanation: null,
        price: null,
        market: null,
        location: { centreKm: null, stationKm: null, radiusKm: area.radiusKm },
        hotelSuggestions: area.hotelSuggestions,
        snapshotDate: null,
        bundleDate: null,
        coverage,
      };
  const usesListings = base.availability === "market";
  return {
    ...base,
    attribution: usesListings ? (options.attribution ?? DEFAULT_STAY_ATTRIBUTION) : null,
    note: stayNote({ ...base }),
  };
}

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

const inBox = (lat: number, lon: number, b: Bbox) => lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;

/** The value at quantile q (0..1) of an ascending list, by linear interpolation. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Trim the stored cells to the viewport and the page size. The colour scale (10th to 90th percentile of the city's cell prices)
 * comes from all of the city's cells, so colours do not shift when the viewport moves. When more cells match than fit, the
 * ones with the most listings stay.
 */
export function cellsResponse(
  markets: StoredMarket[],
  options: { bbox?: Bbox; limit: number; layer: "h3" | "neighbourhood"; attribution?: string | null },
) {
  const cities: { cityCode: string; cityName: string; snapshotDate: string | null; cityMedianCad: number | null; scale: { low: number; high: number } | null }[] = [];
  let matched: StayCell[] = [];
  for (const m of markets) {
    const all = m.rows.map((r): StayCell => {
      const [id, lat, lon, price, pp, listings, score, name] = r as [string, number, number, number | null, number | null, number, number | null, string?];
      return { id, ...(name ? { name } : {}), city: m.cityCode, lat, lon, price, pp, listings, score };
    });
    const prices = all.map((c) => c.price).filter((p): p is number => p != null).sort((a, b) => a - b);
    cities.push({
      cityCode: m.cityCode,
      cityName: m.name,
      snapshotDate: m.snapshotDate,
      cityMedianCad: typeof m.city?.medianPriceCad === "number" ? m.city.medianPriceCad : null,
      scale: prices.length ? { low: Math.round(quantile(prices, 0.1)), high: Math.round(quantile(prices, 0.9)) } : null,
    });
    matched = matched.concat(options.bbox ? all.filter((c) => inBox(c.lat, c.lon, options.bbox!)) : all);
  }
  const total = matched.length;
  const cells = total > options.limit ? [...matched].sort((a, b) => b.listings - a.listings || a.id.localeCompare(b.id)).slice(0, options.limit) : matched;
  return {
    cities,
    cells,
    truncated: total > cells.length,
    total,
    attribution: cells.length ? (options.attribution ?? DEFAULT_STAY_ATTRIBUTION) : null,
  };
}

/** Best first: listed by more sources, with stars and a website, then closest to the Area's centre. */
export function rankHotels(hotels: StoredHotel[]): StoredHotel[] {
  const score = (h: StoredHotel) => h.nSources * 10 + (h.stars ?? 0) * 2 + (h.website ? 3 : 0);
  return [...hotels].sort((a, b) => score(b) - score(a) || (a.areaDistKm ?? 99) - (b.areaDistKm ?? 99) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function toSuggestion(h: StoredHotel): HotelSuggestion {
  return {
    id: h.id,
    name: h.name,
    nameLocal: h.nameLocal,
    kind: h.kind,
    lat: h.lat,
    lon: h.lon,
    address: h.address,
    website: h.website,
    stars: h.stars,
    nSources: h.nSources,
    distanceKm: h.areaDistKm,
    sources: [...new Map(h.sources.map((s) => [`${s.source}|${s.licence}`, { source: s.source, licence: s.licence }])).values()],
  };
}

export const attributionOf = (view: unknown): string | null => {
  const a = (view as Partial<DataStayView> | null)?.attribution;
  return typeof a === "string" && a ? a : null;
};
