import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { BundleHotel, BundleManifest, BundlePlace, BundleSourceInfo, BundleStay, BundleStayUnit } from "@trippr/contracts";
import { place, SOURCES, writeBundle } from "./bundle-kit";

/** Test bundles with stay tables, written the way the pipeline does (gzip JSON Lines, checksums in the manifest). */

const FETCHED = "2026-11-18T00:00:00Z";

export const STAY_SOURCES: BundleSourceInfo[] = [
  ...SOURCES,
  {
    id: "insideairbnb",
    name: "Inside Airbnb",
    url: "https://insideairbnb.com/get-the-data/",
    licence: "CC BY 4.0",
    licence_detail: null,
    licence_urls: ["https://creativecommons.org/licenses/by/4.0/"],
    attribution: "Data from Inside Airbnb (insideairbnb.com), CC BY 4.0",
    terms_checked_on: "2026-11-23",
    allowed_uses: ["Aggregate and show the aggregates with attribution"],
    enabled: true,
    version: null,
    fetched_at: FETCHED,
    staged_rows: 1000,
    places: 0,
  },
  {
    id: "osm_lodging",
    name: "OpenStreetMap lodging",
    url: "https://www.openstreetmap.org/",
    licence: "ODbL-1.0",
    licence_detail: null,
    licence_urls: ["https://opendatacommons.org/licenses/odbl/1-0/"],
    attribution: "© OpenStreetMap contributors, available under the Open Database Licence",
    terms_checked_on: "2026-11-23",
    allowed_uses: ["Show with attribution"],
    enabled: true,
    version: null,
    fetched_at: FETCHED,
    staged_rows: 100,
    places: 0,
  },
];

/** A valid stay unit with nothing measured; override what a test needs. */
export function unit(over: Partial<BundleStayUnit> & Pick<BundleStayUnit, "unit_kind" | "unit_id" | "city_code">): BundleStayUnit {
  return {
    name: over.unit_id,
    lat: 35.66,
    lon: 139.7,
    radius_km: null,
    area_km2: null,
    centre_km: 5,
    station_km: 5,
    snapshot_date: null,
    n_listings: 0,
    n_priced: 0,
    n_rated: 0,
    n_reviewed10: null,
    median_price_cad: null,
    p25_price_cad: null,
    p75_price_cad: null,
    median_price_entire_cad: null,
    median_price_private_cad: null,
    median_price_pp_cad: null,
    entire_home_share: null,
    private_room_share: null,
    other_room_share: null,
    median_rating: null,
    reviews_ltm: null,
    reviews_per_listing: null,
    unavailable_share: null,
    median_availability_365: null,
    est_occupancy_share: null,
    listing_density_km2: null,
    licensed_share: null,
    multi_host_share: null,
    top_hosts_share: null,
    n_hotels: null,
    n_places: null,
    n_nightlife: null,
    cheaper_than_share: null,
    score_value: null,
    score_reviews: null,
    score_centrality: null,
    score_walkability: null,
    score_quiet: null,
    stay_score: null,
    score_parts: [],
    weight_coverage: null,
    low_sample: null,
    explanation: null,
    ...over,
  };
}

/** The city row Inside Airbnb data gives a covered city. */
export const cityUnit = (code: string, name: string, over: Partial<BundleStayUnit> = {}) =>
  unit({
    unit_kind: "city",
    unit_id: code,
    city_code: code,
    name,
    radius_km: 25,
    centre_km: 0,
    snapshot_date: "2026-09-25",
    n_listings: 115,
    n_priced: 106,
    n_rated: 100,
    median_price_cad: 137.41,
    median_price_pp_cad: 38.29,
    median_rating: 4.8,
    ...over,
  });

/** A fully measured Area (market numbers and all five parts). */
export const marketArea = (id: string, city: string, name: string, over: Partial<BundleStayUnit> = {}) =>
  unit({
    unit_kind: "area",
    unit_id: id,
    city_code: city,
    name,
    radius_km: 1.5,
    centre_km: 3.2,
    station_km: 3.2,
    snapshot_date: "2026-09-25",
    n_listings: 40,
    n_priced: 38,
    n_rated: 35,
    median_price_cad: 197.32,
    p25_price_cad: 144.16,
    p75_price_cad: 245.53,
    median_price_entire_cad: 220,
    median_price_private_cad: 110,
    median_price_pp_cad: 80.5,
    entire_home_share: 0.6,
    private_room_share: 0.35,
    median_rating: 4.82,
    unavailable_share: 0.42,
    listing_density_km2: 5.6,
    multi_host_share: 0.2,
    top_hosts_share: 0.1,
    n_hotels: 2,
    n_places: 70,
    n_nightlife: 8,
    score_value: 30.5,
    score_reviews: 82,
    score_centrality: 70,
    score_walkability: 90,
    score_quiet: 40,
    stay_score: 59.9,
    score_parts: ["value", "reviews", "centrality", "walkability", "quiet"],
    weight_coverage: 1,
    low_sample: false,
    explanation: "Cheaper than 30% of Tokyo listings: median CAD 197 a night; 3.2 km from the city centre; 70 places within 600 m.",
    ...over,
  });

export const cell = (id: string, city: string, lat: number, lon: number, over: Partial<BundleStayUnit> = {}) =>
  unit({ unit_kind: "h3", unit_id: id, city_code: city, name: id, lat, lon, snapshot_date: "2026-09-25", n_listings: 5, n_priced: 5, median_price_cad: 120, median_price_pp_cad: 50, stay_score: 55, ...over });

let hotelCounter = 0;
export function hotel(areaId: string, city: string, over: Partial<BundleHotel> = {}): BundleHotel {
  const n = ++hotelCounter;
  return {
    id: `h_test${String(n).padStart(8, "0")}`,
    city_code: city,
    area_id: areaId,
    area_dist_km: 0.4,
    name: `Test Hotel ${n}`,
    name_local: null,
    name_en: null,
    kind: "hotel",
    lat: 35.66 + n / 10_000,
    lon: 139.7,
    address: null,
    website: null,
    phone: null,
    stars: null,
    wikidata_qid: null,
    confidence: 0.8,
    n_sources: 1,
    sources: [{ source: "overture", source_id: `ov-${n}`, licence: "CDLA-Permissive-2.0", fetched_at: FETCHED }],
    ...over,
  };
}

export interface StayBundleOptions {
  date: string;
  places?: BundlePlace[];
  units: BundleStayUnit[];
  hotels: BundleHotel[];
  /** Check results shown on the Data page. */
  checks?: BundleStay["checks"];
  coveredOf?: number;
  /** Corrupt the stay_unit file after the manifest was written. */
  corrupt?: "units";
  /** Write the stay files but leave the stay section out of the manifest. */
  noSection?: boolean;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const lines = (rows: unknown[]) => gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8"));

/** A bundle of places plus stay tables. */
export function writeStayBundle(root: string, options: StayBundleOptions): string {
  const dir = writeBundle(root, { date: options.date, places: options.places ?? [place({ name: `Stay Fixture ${options.date}`, city_code: "TYO" })], sources: STAY_SOURCES });
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BundleManifest;
  const unitsFile = lines(options.units);
  const hotelsFile = lines(options.hotels);
  const kinds = ["city", "area", "neighbourhood", "h3"] as const;
  const cities = options.units.filter((u) => u.unit_kind === "city");
  manifest.files.push(
    { name: "stay_unit.jsonl.gz", sha256: sha(unitsFile), bytes: unitsFile.length, rows: options.units.length },
    { name: "hotels.jsonl.gz", sha256: sha(hotelsFile), bytes: hotelsFile.length, rows: options.hotels.length },
  );
  if (!options.noSection) {
    manifest.stay = {
      run_date: options.date,
      units: Object.fromEntries(kinds.map((k) => [k, options.units.filter((u) => u.unit_kind === k).length])),
      hotels: options.hotels.length,
      hotels_in_areas: options.hotels.length,
      hotels_per_area_cap: 150,
      cities: cities.map((c) => ({ city_code: c.city_code, name: c.name ?? c.city_code, snapshot_date: c.snapshot_date, n_listings: c.n_listings, n_priced: c.n_priced, median_price_cad: c.median_price_cad, median_price_pp_cad: c.median_price_pp_cad })),
      coverage: { trippr_cities: 108, inside_airbnb_cities: options.coveredOf ?? cities.length, cities_with_places: cities.length },
      weights: { value: 0.25, centrality: 0.3, walkability: 0.2, quiet: 0.15, reviews: 0.1 },
      checks: options.checks === undefined ? { passed: true, results: [{ name: "stay.unit.unique_ids", status: "pass", detail: "unit ids are unique per kind" }] } : options.checks,
    };
  }
  writeFileSync(join(dir, "stay_unit.jsonl.gz"), options.corrupt === "units" ? Buffer.concat([unitsFile, Buffer.from("x")]) : unitsFile);
  writeFileSync(join(dir, "hotels.jsonl.gz"), hotelsFile);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}
