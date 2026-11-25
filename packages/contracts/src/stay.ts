import { z } from "zod";
import { cityCode } from "./schemas";

/**
 * Stay analytics (docs/data-platform-spec.md, Feature 5): the optional stay tables of the seed bundle
 * (pipelines/src/trippr_data/bundle_stay.py), the Area stay card, the H3 cells of the "Stay prices" map layer,
 * hotel suggestions for an Area and the Data page's stay section.
 *
 * Inside Airbnb data is CC BY 4.0 and only aggregates are published: nothing here can carry a listing id, a host id,
 * a listing name or a link to an individual listing.
 */

// --- the bundle's stay tables -----------------------------------------------------------------------

export const STAY_BUNDLE_FILES = {
  units: "stay_unit.jsonl.gz",
  hotels: "hotels.jsonl.gz",
  unitsParquet: "stay_unit.parquet",
  hotelsParquet: "hotels.parquet",
} as const;

export const STAY_UNIT_KINDS = ["city", "area", "neighbourhood", "h3"] as const;
export type StayUnitKind = (typeof STAY_UNIT_KINDS)[number];

const num = z.number().nullable();
const int = z.number().int().nullable();
const utcTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "Expected a UTC timestamp like 2026-11-22T18:13:26Z");
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One row of the pipeline's stay_unit table: aggregates, score parts and the sentence that explains them. */
export const bundleStayUnitSchema = z
  .object({
    unit_kind: z.enum(STAY_UNIT_KINDS),
    unit_id: z.string().min(1),
    city_code: cityCode,
    name: z.string().nullable(),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    radius_km: num,
    area_km2: num,
    centre_km: num,
    station_km: num,
    snapshot_date: isoDay.nullable(),
    n_listings: z.number().int().min(0),
    n_priced: z.number().int().min(0),
    n_rated: z.number().int().min(0),
    n_reviewed10: int,
    median_price_cad: num,
    p25_price_cad: num,
    p75_price_cad: num,
    median_price_entire_cad: num,
    median_price_private_cad: num,
    median_price_pp_cad: num,
    entire_home_share: num,
    private_room_share: num,
    other_room_share: num,
    median_rating: num,
    reviews_ltm: int,
    reviews_per_listing: num,
    unavailable_share: num,
    median_availability_365: num,
    est_occupancy_share: num,
    listing_density_km2: num,
    licensed_share: num,
    multi_host_share: num,
    top_hosts_share: num,
    n_hotels: int,
    n_places: int,
    n_nightlife: int,
    cheaper_than_share: num,
    score_value: num,
    score_reviews: num,
    score_centrality: num,
    score_walkability: num,
    score_quiet: num,
    stay_score: num,
    score_parts: z.array(z.string()),
    weight_coverage: num,
    low_sample: z.boolean().nullable(),
    explanation: z.string().nullable(),
  })
  .strict();
export type BundleStayUnit = z.infer<typeof bundleStayUnitSchema>;

export const bundleHotelSourceSchema = z
  .object({ source: z.string().min(1), source_id: z.string().min(1), licence: z.string().min(1), fetched_at: utcTimestamp })
  .strict();

/** An open-data hotel inside an Area's radius (Overture, Foursquare, OpenStreetMap lodging), with its source records. */
export const bundleHotelSchema = z
  .object({
    id: z.string().min(1).max(80),
    city_code: cityCode,
    area_id: z.string().min(1),
    area_dist_km: num,
    name: z.string().min(1).max(300),
    name_local: z.string().nullable(),
    name_en: z.string().nullable(),
    kind: z.string().min(1),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    address: z.string().nullable(),
    website: z.string().nullable(),
    phone: z.string().nullable(),
    stars: z.number().int().min(1).max(5).nullable(),
    wikidata_qid: z.string().nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    n_sources: z.number().int().min(1),
    sources: z.array(bundleHotelSourceSchema).min(1),
  })
  .strict();
export type BundleHotel = z.infer<typeof bundleHotelSchema>;

const stayCheckSchema = z.object({ name: z.string(), status: z.enum(["pass", "fail", "warn", "info"]), detail: z.string() }).strict();

/** The manifest's `stay` section: what the Data page shows about stay analytics. */
export const bundleStaySchema = z
  .object({
    run_date: isoDay,
    units: z.record(z.number().int().min(0)),
    hotels: z.number().int().min(0),
    hotels_in_areas: z.number().int().min(0),
    hotels_per_area_cap: z.number().int().min(1),
    cities: z.array(
      z
        .object({
          city_code: cityCode,
          name: z.string(),
          snapshot_date: isoDay.nullable(),
          n_listings: z.number().int().min(0),
          n_priced: z.number().int().min(0),
          median_price_cad: num,
          median_price_pp_cad: num,
        })
        .strict(),
    ),
    coverage: z.object({ trippr_cities: z.number().int().min(0), inside_airbnb_cities: z.number().int().min(0), cities_with_places: z.number().int().min(0) }).strict(),
    weights: z.record(z.number()),
    checks: z.object({ passed: z.boolean(), results: z.array(stayCheckSchema) }).strict().nullable(),
  })
  .strict();
export type BundleStay = z.infer<typeof bundleStaySchema>;

// --- the Area stay card ------------------------------------------------------------------------------

export const STAY_PART_KEYS = ["value", "centrality", "walkability", "quiet", "reviews"] as const;
export type StayPartKey = (typeof STAY_PART_KEYS)[number];

export const STAY_PART_LABELS: Record<StayPartKey, string> = {
  value: "Value",
  centrality: "Central",
  walkability: "Walkable",
  quiet: "Quiet",
  reviews: "Reviews",
};

/** One part of the stay score, shown with its weight so the score is never a bare number. */
export interface StayPart {
  key: StayPartKey;
  label: string;
  /** 0 to 100, higher is better; null when there was not enough data for this part. */
  score: number | null;
  /** The part's share of the whole score (0 to 1) before rescaling to the parts that exist. */
  weight: number;
}

/**
 * What the data says about an Area:
 * - "market": Inside Airbnb has enough listings in the Area for prices and reviews;
 * - "places": no listing statistics for this Area (the city has no Inside Airbnb data, or too few listings), so the
 *   score, if any, comes from location and nearby places only;
 * - "none": nothing, e.g. an area the group added, or a bundle without stay data.
 */
export type StayAvailability = "market" | "places" | "none";

export interface StayCoverage {
  /** Cities with Inside Airbnb data. */
  coveredCities: number;
  /** Cities in Trippr. */
  trippCities: number;
  /** "Inside Airbnb covers 5 of 108 cities." */
  note: string;
}

export const coverageNote = (covered: number, total: number) => `Inside Airbnb covers ${covered} of ${total} cities`;

export interface StayPrice {
  /** Median nightly price for the whole place, CAD, and the middle half around it. */
  medianCad: number | null;
  p25Cad: number | null;
  p75Cad: number | null;
  /** Median per person per night. */
  perPersonCad: number | null;
  entireHomeCad: number | null;
  privateRoomCad: number | null;
  /** The city's median for comparison, when the city has Inside Airbnb data. */
  cityMedianCad: number | null;
}

export interface StayMarketStats {
  listings: number;
  priced: number;
  rated: number;
  medianRating: number | null;
  entireHomeShare: number | null;
  privateRoomShare: number | null;
  /** Share of the next year's nights that are booked or blocked. */
  unavailableShare: number | null;
  listingsPerKm2: number | null;
  multiHostShare: number | null;
  topHostsShare: number | null;
  /** Fewer priced listings than the pipeline wants for a stable median. */
  lowSample: boolean;
}

/** GET /areas/:id/stay. */
export interface AreaStay {
  areaId: string;
  cityCode: string;
  cityName: string;
  availability: StayAvailability;
  /** Inside Airbnb has data for the Area's city (even if this Area has none of its own). */
  cityCovered: boolean;
  score: number | null;
  parts: StayPart[];
  /** Share of the score's weight the available parts carry (0 to 1). */
  weightCoverage: number | null;
  explanation: string | null;
  price: StayPrice | null;
  market: StayMarketStats | null;
  /** Distance from the Area's centre to the city centre and the nearest hub station; the radius the numbers are for. */
  location: { centreKm: number | null; stationKm: number | null; radiusKm: number | null };
  /** Open-data hotels the load job holds for this Area (see GET /areas/:id/hotel-suggestions). */
  hotelSuggestions: number;
  /** Inside Airbnb's snapshot the numbers come from. */
  snapshotDate: string | null;
  bundleDate: string | null;
  coverage: StayCoverage | null;
  /** The attribution to show next to listing-based numbers; null when none were used. */
  attribution: string | null;
  /** One honest sentence about what this card can and cannot say. */
  note: string;
}

export const DEFAULT_STAY_ATTRIBUTION = "Data from Inside Airbnb (insideairbnb.com), CC BY 4.0";

// --- the H3 cells of the map layer --------------------------------------------------------------------

export const STAY_CELLS_MAX = 3000;
export const STAY_CELLS_DEFAULT = 1500;

const bbox = z
  .string()
  .transform((s) => s.split(",").map((v) => Number(v)))
  .refine((v) => v.length === 4 && v.every((n) => Number.isFinite(n)), "bbox is minLon,minLat,maxLon,maxLat")
  .refine((v) => v[0]! >= -180 && v[2]! <= 180 && v[1]! >= -90 && v[3]! <= 90 && v[0]! <= v[2]! && v[1]! <= v[3]!, "bbox is outside the world or upside down")
  .transform((v) => ({ minLon: v[0]!, minLat: v[1]!, maxLon: v[2]!, maxLat: v[3]! }));
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

export const STAY_LAYERS = ["h3", "neighbourhood"] as const;
export type StayLayer = (typeof STAY_LAYERS)[number];

/** GET /trips/:id/stay/cells: a city, a viewport, or both. At least one is needed. */
export const stayCellsQuery = z
  .object({
    /** h3: resolution-8 hexagons (the map's "Stay prices" layer); neighbourhood: Inside Airbnb's neighbourhoods as points. */
    layer: z.enum(STAY_LAYERS).default("h3"),
    city: z.preprocess(emptyToUndefined, cityCode.optional()),
    bbox: z.preprocess(emptyToUndefined, bbox.optional()),
    limit: z.coerce.number().int().min(1).max(STAY_CELLS_MAX).default(STAY_CELLS_DEFAULT),
  })
  .refine((q) => q.city || q.bbox, "Pass city or bbox");

/**
 * One resolution-8 H3 cell with at least 3 listings (or, for layer=neighbourhood, one Inside Airbnb neighbourhood at its
 * centre). Prices are Inside Airbnb asking prices in CAD.
 */
export interface StayCell {
  /** The H3 index, or "TYO/Shibuya Ku" for a neighbourhood. */
  id: string;
  /** Neighbourhood layer only. */
  name?: string;
  /** The city the cell belongs to (its colour scale is in `cities`). */
  city: string;
  lat: number;
  lon: number;
  /** Median nightly price of the listings in the cell; null under the privacy minimum or without priced listings. */
  price: number | null;
  /** Median per person per night. */
  pp: number | null;
  listings: number;
  /** The stay score of the cell, when it has one. */
  score: number | null;
}

export interface StayCityLayer {
  cityCode: string;
  cityName: string;
  snapshotDate: string | null;
  /** The city's median nightly price, the reference for the colour scale. */
  cityMedianCad: number | null;
  /** The 10th and 90th percentile of the city's cell prices: the ends of the colour scale. */
  scale: { low: number; high: number } | null;
}

export interface StayCellsResponse {
  cities: StayCityLayer[];
  cells: StayCell[];
  /** More cells matched than were returned (the response is capped); zoom in or narrow the viewport. */
  truncated: boolean;
  total: number;
  /** Always set when there are cells: Inside Airbnb is CC BY 4.0. */
  attribution: string | null;
}

// --- hotel suggestions ----------------------------------------------------------------------------------

export const HOTEL_KINDS = ["hotel", "hostel", "guest_house", "apartment", "resort", "inn", "motel", "other"] as const;

export interface HotelSuggestion {
  id: string;
  name: string;
  nameLocal: string | null;
  kind: string;
  lat: number;
  lon: number;
  address: string | null;
  website: string | null;
  stars: number | null;
  /** How many sources list it (more is more certain it exists and is open). */
  nSources: number;
  distanceKm: number | null;
  /** Source ids and licences, for the attribution Overture, Foursquare and OpenStreetMap ask for. */
  sources: { source: string; licence: string }[];
}

export interface HotelSuggestionsResponse {
  areaId: string;
  areaName: string;
  cityCode: string;
  cityName: string;
  hotels: HotelSuggestion[];
  total: number;
  /** One line per distinct source: "Overture Maps Foundation, CDLA-Permissive-2.0 ...". */
  attributions: string[];
}

export const hotelSuggestionsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });

// --- the Data page --------------------------------------------------------------------------------------

export interface DataStayView {
  bundleDate: string;
  loadedAt: string;
  runDate: string;
  coverage: StayCoverage;
  /** Inside Airbnb cities with the snapshot the numbers come from. */
  cities: { cityCode: string; name: string; snapshotDate: string | null; listings: number; pricedListings: number; medianPriceCad: number | null }[];
  units: Record<string, number>;
  hotels: { inGraph: number; inAreas: number; perAreaCap: number };
  weights: Record<string, number>;
  checks: { passed: boolean; results: { name: string; status: "pass" | "fail" | "warn" | "info"; detail: string }[] } | null;
  attribution: string;
  licence: string;
}
