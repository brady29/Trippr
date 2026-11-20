/**
 * Shared MapLibre setup for the route editor's map and the Map tab: the
 * basemap style, map creation, the route line layers (solid trains, dashed
 * arcs for flights, dotted boats and roads) and numbered stop markers.
 * Only import from components loaded with next/dynamic (ssr: false).
 */
import maplibregl, { type LngLatLike } from "maplibre-gl";

export const MAP_STYLE = process.env.NEXT_PUBLIC_MAP_STYLE ?? "https://tiles.openfreemap.org/styles/positron";

/** A font the OpenFreeMap glyph server has; a missing font fails the source's tiles. */
export const MAP_FONT = ["Noto Sans Regular"];

export const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** A map over East Asia with zoom buttons; scroll-zoom needs ctrl/cmd so the page still scrolls. */
export function createMap(container: HTMLElement, opts: { center?: [number, number]; zoom?: number } = {}): maplibregl.Map {
  const m = new maplibregl.Map({
    container,
    style: MAP_STYLE,
    center: opts.center ?? [112, 18],
    zoom: opts.zoom ?? 2.4,
    attributionControl: { compact: true },
    cooperativeGestures: true,
  });
  m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  return m;
}

export const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** Adds the "route" source and its rail, flight and other line layers. */
export function addRouteLayers(m: maplibregl.Map, source = "route") {
  m.addSource(source, { type: "geojson", data: EMPTY });
  m.addLayer({
    id: `${source}-rail`,
    type: "line",
    source,
    filter: ["==", ["get", "kind"], "rail"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#2e7a59", "line-width": 3.5 },
  });
  m.addLayer({
    id: `${source}-flight`,
    type: "line",
    source,
    filter: ["==", ["get", "kind"], "flight"],
    layout: { "line-cap": "butt" },
    paint: { "line-color": "#3867c8", "line-width": 2.25, "line-dasharray": [3, 2] },
  });
  m.addLayer({
    id: `${source}-other`,
    type: "line",
    source,
    filter: ["==", ["get", "kind"], "other"],
    layout: { "line-cap": "round" },
    paint: { "line-color": "#8a6d3b", "line-width": 2.5, "line-dasharray": [0.4, 1.6] },
  });
}

/** A numbered stop marker; a button so it can be reached with the keyboard. */
export function stopMarker(
  m: maplibregl.Map,
  stop: { n: number; name: string; code?: string; lat: number; lon: number },
  onClick: () => void,
  highlighted = false,
): maplibregl.Marker {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `grid h-5 w-5 place-items-center rounded-full bg-[#0f151d] font-mono text-[10px] font-semibold text-[#ffc23d] shadow ring-2 ${
    highlighted ? "ring-[#ffc23d]" : "ring-white"
  }`;
  el.textContent = String(stop.n);
  el.title = stop.code ? `${stop.n}. ${stop.name} (${stop.code})` : `${stop.n}. ${stop.name}`;
  el.setAttribute("aria-label", `Stop ${stop.n}: ${stop.name}`);
  el.onclick = onClick;
  return new maplibregl.Marker({ element: el }).setLngLat([stop.lon, stop.lat] as LngLatLike).addTo(m);
}

/** Frames the points; a single point gets a sensible zoom instead of the max. */
export function fitTo(m: maplibregl.Map, points: [number, number][], opts: { padding?: number; maxZoom?: number } = {}) {
  if (!points.length) return;
  const duration = reducedMotion() ? 0 : 600;
  if (points.length === 1) {
    m.easeTo({ center: points[0]!, zoom: Math.min(opts.maxZoom ?? 13, 13), duration });
    return;
  }
  const bounds = new maplibregl.LngLatBounds();
  points.forEach((p) => bounds.extend(p));
  m.fitBounds(bounds, { padding: opts.padding ?? 48, maxZoom: opts.maxZoom ?? 6, duration });
}
