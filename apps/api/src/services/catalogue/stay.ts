import { createHash } from "node:crypto";
import {
  coverageNote,
  DEFAULT_STAY_ATTRIBUTION,
  STAY_PART_KEYS,
  STAY_PART_LABELS,
  type AreaStay,
  type BundleHotel,
  type BundleStayUnit,
  type DataStayView,
} from "@trippr/contracts";
import { nowIso } from "../../ids";
import type { Repositories } from "../../repositories";
import type { StayHotelRow, StayAreaRow, StayMarketRow } from "../../repositories/stay";
import type { LoadedBundle } from "./bundle";

/** What the Area node keeps as JSON; the API adds the Area's name, the coverage note and the attribution when it answers. */
export type StoredAreaStay = Omit<AreaStay, "areaId" | "cityCode" | "cityName" | "bundleDate" | "coverage" | "attribution" | "note">;

export interface StaySummary {
  bundleDate: string;
  /** Areas of the bundle that exist in the graph and now carry stay data. */
  areas: number;
  /** Areas that had stay data from an older bundle and lost it. */
  areasCleared: number;
  /** Cities with Inside Airbnb data. */
  markets: number;
  cells: number;
  hotels: {
    created: number;
    refreshed: number;
    unchanged: number;
    removed: number;
    /** Hotels whose Area is not in the graph (the group deleted it): left out. */
    skippedNoArea: number;
  };
}

const sha1 = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex");
const round = (value: number | null | undefined, digits: number) => (value == null ? null : Math.round(value * 10 ** digits) / 10 ** digits);

/** The Area's stay card as the load job stores it. `city` is the city's own row, for comparison. */
export function storedAreaStay(
  unit: BundleStayUnit,
  options: { city: BundleStayUnit | null; weights: Record<string, number>; hotelSuggestions: number },
): StoredAreaStay {
  const { city, weights } = options;
  const hasPrices = unit.median_price_cad != null;
  const availability: StoredAreaStay["availability"] = hasPrices ? "market" : unit.stay_score != null ? "places" : "none";
  const scores: Record<string, number | null> = {
    value: unit.score_value,
    centrality: unit.score_centrality,
    walkability: unit.score_walkability,
    quiet: unit.score_quiet,
    reviews: unit.score_reviews,
  };
  return {
    availability,
    cityCovered: city != null,
    score: unit.stay_score,
    parts: STAY_PART_KEYS.map((key) => ({ key, label: STAY_PART_LABELS[key], score: scores[key] ?? null, weight: weights[key] ?? 0 })),
    weightCoverage: unit.weight_coverage,
    explanation: unit.explanation,
    price: hasPrices
      ? {
          medianCad: unit.median_price_cad,
          p25Cad: unit.p25_price_cad,
          p75Cad: unit.p75_price_cad,
          perPersonCad: unit.median_price_pp_cad,
          entireHomeCad: unit.median_price_entire_cad,
          privateRoomCad: unit.median_price_private_cad,
          cityMedianCad: city?.median_price_cad ?? null,
        }
      : null,
    market: hasPrices
      ? {
          listings: unit.n_listings,
          priced: unit.n_priced,
          rated: unit.n_rated,
          medianRating: unit.median_rating,
          entireHomeShare: unit.entire_home_share,
          privateRoomShare: unit.private_room_share,
          unavailableShare: unit.unavailable_share,
          listingsPerKm2: unit.listing_density_km2,
          multiHostShare: unit.multi_host_share,
          topHostsShare: unit.top_hosts_share,
          lowSample: unit.low_sample ?? false,
        }
      : null,
    location: { centreKm: unit.centre_km, stationKm: unit.station_km, radiusKm: unit.radius_km },
    hotelSuggestions: options.hotelSuggestions,
    snapshotDate: unit.snapshot_date,
  };
}

/** One compact row per cell for the map layer: [id, lat, lon, price, price per person, listings, score, name?]. */
export type CompactCell = [string, number, number, number | null, number | null, number, number | null, string?];

export const compactCell = (u: BundleStayUnit): CompactCell => {
  const row: CompactCell = [u.unit_id, round(u.lat, 5)!, round(u.lon, 5)!, round(u.median_price_cad, 0), round(u.median_price_pp_cad, 0), u.n_listings, round(u.stay_score, 0)];
  if (u.unit_kind === "neighbourhood") row.push(u.name ?? u.unit_id);
  return row;
};

/** A city's market row: its summary, its H3 cells and its neighbourhoods, as JSON strings. */
export function marketRow(cityCode: string, units: BundleStayUnit[], bundleDate: string): StayMarketRow | null {
  const city = units.find((u) => u.unit_kind === "city" && u.city_code === cityCode);
  if (!city) return null;
  const cells = units.filter((u) => u.unit_kind === "h3" && u.city_code === cityCode).map(compactCell);
  const neighbourhoods = units.filter((u) => u.unit_kind === "neighbourhood" && u.city_code === cityCode).map(compactCell);
  const lats = cells.map((c) => c[1]).concat(neighbourhoods.map((c) => c[1]));
  const lons = cells.map((c) => c[2]).concat(neighbourhoods.map((c) => c[2]));
  const summary = {
    listings: city.n_listings,
    priced: city.n_priced,
    medianPriceCad: city.median_price_cad,
    medianPricePpCad: city.median_price_pp_cad,
    medianRating: city.median_rating,
    entireHomeShare: city.entire_home_share,
  };
  const row = {
    cityCode,
    name: city.name ?? cityCode,
    snapshotDate: city.snapshot_date,
    bundleDate,
    city: JSON.stringify(summary),
    cells: JSON.stringify(cells),
    neighbourhoods: JSON.stringify(neighbourhoods),
    cellCount: cells.length,
    // The box around the city's cells, a little wider than the cells themselves (a cell is about 1 km across).
    minLat: lats.length ? Math.min(...lats) - 0.02 : city.lat - 0.3,
    maxLat: lats.length ? Math.max(...lats) + 0.02 : city.lat + 0.3,
    minLon: lons.length ? Math.min(...lons) - 0.02 : city.lon - 0.3,
    maxLon: lons.length ? Math.max(...lons) + 0.02 : city.lon + 0.3,
  };
  return { ...row, hash: sha1(row) };
}

export function hotelRow(h: BundleHotel, bundleDate: string, now: string): StayHotelRow {
  const content = [
    h.name, h.name_local, h.name_en, h.kind, h.lat, h.lon, h.address, h.website, h.phone, h.stars, h.wikidata_qid, h.confidence,
    h.n_sources, h.area_id, h.area_dist_km, h.city_code, h.sources.map((s) => [s.source, s.source_id, s.licence, s.fetched_at]),
  ];
  return {
    id: h.id,
    areaId: h.area_id,
    cityCode: h.city_code,
    name: h.name_en ?? h.name,
    nameLocal: h.name_local ?? (h.name_en && h.name !== h.name_en ? h.name : null),
    nameEn: h.name_en,
    kind: h.kind,
    lat: h.lat,
    lon: h.lon,
    address: h.address,
    website: h.website,
    phone: h.phone,
    stars: h.stars,
    wikidataQid: h.wikidata_qid,
    confidence: h.confidence,
    nSources: h.n_sources,
    areaDistKm: h.area_dist_km,
    sources: JSON.stringify(h.sources.map((s) => ({ source: s.source, sourceId: s.source_id, licence: s.licence }))),
    sourceIds: [...new Set(h.sources.map((s) => s.source))],
    contentHash: sha1(content),
    bundleDate,
    now,
  };
}

export interface StayLoadOptions {
  dryRun?: boolean;
  now?: () => string;
}

/** The Data page's stay section, built once at load time. */
export function dataStayView(bundle: LoadedBundle, hotelsInGraph: number, now: string): DataStayView {
  const stay = bundle.stay!;
  const airbnb = bundle.sources.find((s) => s.id === "insideairbnb");
  return {
    bundleDate: bundle.date,
    loadedAt: now,
    runDate: stay.section.run_date,
    coverage: {
      coveredCities: stay.section.coverage.inside_airbnb_cities,
      trippCities: stay.section.coverage.trippr_cities,
      note: coverageNote(stay.section.coverage.inside_airbnb_cities, stay.section.coverage.trippr_cities),
    },
    cities: stay.section.cities.map((c) => ({
      cityCode: c.city_code,
      name: c.name,
      snapshotDate: c.snapshot_date,
      listings: c.n_listings,
      pricedListings: c.n_priced,
      medianPriceCad: c.median_price_cad,
    })),
    units: stay.section.units,
    hotels: { inGraph: hotelsInGraph, inAreas: stay.section.hotels_in_areas, perAreaCap: stay.section.hotels_per_area_cap },
    weights: stay.section.weights,
    checks: stay.section.checks,
    attribution: airbnb?.attribution || DEFAULT_STAY_ATTRIBUTION,
    licence: airbnb?.licence || "CC BY 4.0",
  };
}

/**
 * Put a bundle's stay tables in the graph. Idempotent (content hashes), and it only ever touches what the pipeline owns:
 * the stay properties of Areas, StayMarket nodes, and Hotel nodes with `catalogue = true`. The group's own hotels, stays,
 * bookings, votes and Area text are never read or changed. A bundle without stay tables changes nothing.
 */
export async function loadStay(repos: Repositories, bundle: LoadedBundle, options: StayLoadOptions = {}): Promise<StaySummary | null> {
  const stay = bundle.stay;
  if (!stay) return null;
  const now = (options.now ?? nowIso)();
  const [areaHashes, hotelHashes] = await Promise.all([repos.stay.existingAreas(), repos.stay.existingHotels()]);

  const cityUnits = new Map(stay.units.filter((u) => u.unit_kind === "city").map((u) => [u.city_code, u]));
  const hotelsByArea = new Map<string, BundleHotel[]>();
  for (const h of stay.hotels) hotelsByArea.set(h.area_id, [...(hotelsByArea.get(h.area_id) ?? []), h]);

  // Areas that exist in the graph and have a unit in the bundle.
  const areaRows: StayAreaRow[] = [];
  for (const unit of stay.units) {
    if (unit.unit_kind !== "area" || !areaHashes.has(unit.unit_id)) continue;
    const card = storedAreaStay(unit, {
      city: cityUnits.get(unit.city_code) ?? null,
      weights: stay.section.weights,
      hotelSuggestions: (hotelsByArea.get(unit.unit_id) ?? []).filter((h) => areaHashes.has(h.area_id)).length,
    });
    areaRows.push({
      areaId: unit.unit_id,
      stay: JSON.stringify(card),
      score: card.score,
      medianPriceCad: unit.median_price_cad,
      snapshotDate: unit.snapshot_date,
      bundleDate: bundle.date,
      hotelCount: card.hotelSuggestions,
      hash: sha1([card, bundle.date]),
    });
  }
  const keepAreas = areaRows.map((r) => r.areaId);
  const areasCleared = [...areaHashes].filter(([id, hash]) => hash != null && !keepAreas.includes(id)).length;

  const markets = [...cityUnits.keys()].map((code) => marketRow(code, stay.units, bundle.date)).filter((m): m is StayMarketRow => m != null);

  const wanted = stay.hotels.filter((h) => areaHashes.has(h.area_id)).map((h) => hotelRow(h, bundle.date, now));
  const wantedIds = new Set(wanted.map((h) => h.id));
  const create = wanted.filter((h) => !hotelHashes.has(h.id));
  const refresh = wanted.filter((h) => hotelHashes.has(h.id) && hotelHashes.get(h.id) !== h.contentHash);
  const remove = [...hotelHashes.keys()].filter((id) => !wantedIds.has(id));
  const summary: StaySummary = {
    bundleDate: bundle.date,
    areas: areaRows.length,
    areasCleared,
    markets: markets.length,
    cells: markets.reduce((n, m) => n + m.cellCount, 0),
    hotels: {
      created: create.length,
      refreshed: refresh.length,
      unchanged: wanted.length - create.length - refresh.length,
      removed: remove.length,
      skippedNoArea: stay.hotels.length - wanted.length,
    },
  };
  if (options.dryRun) return summary;

  await repos.stay.setAreas(areaRows);
  await repos.stay.clearAreas(keepAreas);
  await repos.stay.upsertMarkets(markets, now);
  await repos.stay.pruneMarkets(markets.map((m) => m.cityCode));

  const changed = [...create, ...refresh];
  await repos.stay.unlinkHotelAreas(refresh.map((h) => h.id));
  await repos.stay.upsertHotels(changed);
  const byId = new Map(stay.hotels.map((h) => [h.id, h]));
  await repos.stay.replaceHotelSources(
    changed.map((h) => h.id),
    changed.flatMap((h) =>
      byId.get(h.id)!.sources.map((s) => ({ hotelId: h.id, source: s.source, sourceId: s.source_id, fetchedAt: s.fetched_at, licence: s.licence })),
    ),
  );
  await repos.stay.removeHotels(remove);

  const view = dataStayView(bundle, wanted.length, now);
  await repos.stay.recordLoad({
    bundleDate: bundle.date,
    now,
    runDate: stay.section.run_date,
    coverageCities: view.coverage.coveredCities,
    trippCities: view.coverage.trippCities,
    stay: JSON.stringify(view),
  });
  return summary;
}
