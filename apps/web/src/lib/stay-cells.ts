import type { StayCell, StayCellsResponse } from "@trippr/contracts";
import { cellToBoundary, isValidCell } from "h3-js";

/**
 * The "Stay prices" map layer: H3 cells from the API as GeoJSON hexagons, coloured on a sequential scale from each
 * city's 10th to 90th percentile cell price (so a dear city and a cheap one both use the whole range).
 * Pure functions; the MapLibre wiring is in components/map/stay-layer.ts.
 */

/** Light (cheaper) to dark (dearer). Five stops, each distinct on the pale basemap and in greyscale. */
export const STAY_RAMP = ["#fbeec1", "#f5c76a", "#e39a3b", "#c4452a", "#7a1f12"] as const;

export type Bbox = { minLon: number; minLat: number; maxLon: number; maxLat: number };

/** Where a price falls between the city's low and high (0 to 1); 0.5 when the city has a single price. */
export function priceRatio(price: number, scale: { low: number; high: number } | null): number {
  if (!scale || scale.high <= scale.low) return 0.5;
  return Math.min(1, Math.max(0, (price - scale.low) / (scale.high - scale.low)));
}

/** The colour of a 0..1 ratio, interpolated between the ramp's stops. Matches the MapLibre expression's output. */
export function rampColor(ratio: number): string {
  const t = Math.min(1, Math.max(0, ratio)) * (STAY_RAMP.length - 1);
  const i = Math.min(STAY_RAMP.length - 2, Math.floor(t));
  const mix = t - i;
  const a = hex(STAY_RAMP[i]!);
  const b = hex(STAY_RAMP[i + 1]!);
  const c = a.map((v, k) => Math.round(v + (b[k]! - v) * mix));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** The hexagon of an H3 cell as a closed GeoJSON ring ([lon, lat]). */
export function cellRing(id: string): [number, number][] {
  if (!isValidCell(id)) throw new Error(`Not an H3 cell: ${id}`);
  const ring = cellToBoundary(id, true) as [number, number][];
  return ring.length && (ring[0]![0] !== ring.at(-1)![0] || ring[0]![1] !== ring.at(-1)![1]) ? [...ring, ring[0]!] : ring;
}

export interface StayFeatureProps {
  id: string;
  city: string;
  price: number;
  pp: number | null;
  listings: number;
  ratio: number;
}

/** Cells with a price become hexagons; a cell without one (under the privacy minimum or unpriced) is left out. */
export function cellsToFeatures(res: Pick<StayCellsResponse, "cells" | "cities">): GeoJSON.FeatureCollection<GeoJSON.Polygon, StayFeatureProps> {
  const scales = new Map(res.cities.map((c) => [c.cityCode, c.scale]));
  const features: GeoJSON.Feature<GeoJSON.Polygon, StayFeatureProps>[] = [];
  for (const c of res.cells) {
    if (c.price == null) continue;
    let ring: [number, number][];
    try {
      ring = cellRing(c.id);
    } catch {
      continue; // an id h3-js cannot read is not drawn
    }
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: { id: c.id, city: c.city, price: c.price, pp: c.pp, listings: c.listings, ratio: priceRatio(c.price, scales.get(c.city) ?? null) },
    });
  }
  return { type: "FeatureCollection", features };
}

export interface LegendRow {
  cityCode: string;
  cityName: string;
  low: number;
  high: number;
  snapshotDate: string | null;
}

/** One legend row per city that has a colour scale. */
export const legendRows = (res: Pick<StayCellsResponse, "cities">): LegendRow[] =>
  res.cities.flatMap((c) => (c.scale ? [{ cityCode: c.cityCode, cityName: c.cityName, low: c.scale.low, high: c.scale.high, snapshotDate: c.snapshotDate }] : []));

/** The viewport as the API's bbox parameter, snapped outward to 0.1 degrees so panning a little does not refetch. */
export function snapBbox(b: [[number, number], [number, number]]): Bbox {
  const [[west, south], [east, north]] = b;
  const clampLon = (v: number) => Math.min(180, Math.max(-180, v));
  const clampLat = (v: number) => Math.min(90, Math.max(-90, v));
  return {
    minLon: clampLon(Math.floor(west * 10) / 10),
    minLat: clampLat(Math.floor(south * 10) / 10),
    maxLon: clampLon(Math.ceil(east * 10) / 10),
    maxLat: clampLat(Math.ceil(north * 10) / 10),
  };
}

export const bboxParam = (b: Bbox) => [b.minLon, b.minLat, b.maxLon, b.maxLat].map((v) => v.toFixed(1)).join(",");

export const cadNight = (n: number | null | undefined) => (n == null ? "n/a" : `CAD ${Math.round(n).toLocaleString("en-CA")}`);

/** The cell a click landed on, for the card under the map. */
export const describeCell = (c: Pick<StayCell, "price" | "pp" | "listings">) =>
  `Median ${cadNight(c.price)} a night${c.pp != null ? ` (${cadNight(c.pp)} a person)` : ""}, from ${c.listings} listings`;
