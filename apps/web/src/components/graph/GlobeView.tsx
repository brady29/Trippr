"use client";

/**
 * 3D globe overlay: MapLibre GL 5 in globe projection.
 *
 * Spike (Nov 2026, maplibre-gl 5.9.0 + @deck.gl/core|layers|mapbox 9.4.0):
 * FAILED. Adding deck.gl's MapboxOverlay to the globe map (interleaved and
 * non-interleaved both tried, with an ArcLayer of 5 flights) stopped
 * MapLibre from drawing every layer after the first few: no basemap
 * labels, no node circles. Removing the control restored rendering.
 * So this uses the spec's fallback: flights are dashed great-circle lines
 * computed client-side and drawn by MapLibre itself (raised arcs would
 * need a small three.js custom layer; not built). deck.gl is not a
 * dependency.
 *
 * Everything is native MapLibre: nodes as circles, rail as solid ground
 * lines, boat and road dotted, flights dashed great circles, and per-city
 * count bubbles below zoom 4 (clustering).
 *
 * Labels must use a font the basemap's glyph server has ("Noto Sans
 * Regular" on OpenFreeMap): a missing font fails the whole source's tiles.
 */
import type { GraphJSON, GraphNode } from "@trippr/contracts";
import maplibregl, { type GeoJSONSource, type LngLatBoundsLike } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import type { GraphIndex, JourneyStep } from "@/lib/graph";
import { placeNode } from "@/lib/graph";
import {
  activityRadius,
  FIXED_DATE,
  lineKind,
  MODE_COLOR,
  nodeColor,
  NODE_LABEL,
  STATUS_OPACITY,
} from "@/lib/graph-palette";

const STYLE = process.env.NEXT_PUBLIC_GLOBE_STYLE ?? "https://tiles.openfreemap.org/styles/dark";
const CLUSTER_BELOW = 4;
const ALWAYS: GraphNode["type"][] = ["city", "airport", "station"];

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export interface CameraRequest {
  key: string;
  bounds: [[number, number], [number, number]];
}

export interface GlobeProps {
  graph: GraphJSON;
  index: GraphIndex;
  selected: string | null;
  step: JourneyStep | null;
  camera: CameraRequest | null;
  onSelect(id: string | null): void;
  onUnavailable(reason: string): void;
}

/** Points along the great circle between two lon/lat pairs. */
function greatCircle(a: [number, number], b: [number, number], steps = 48): [number, number][] {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const [l1, p1] = [toRad(a[0]), toRad(a[1])];
  const [l2, p2] = [toRad(b[0]), toRad(b[1])];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d === 0) return [a, b];
  return Array.from({ length: steps + 1 }, (_, i) => {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    return [toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)))];
  });
}

interface Built {
  points: GeoJSON.FeatureCollection;
  bubbles: GeoJSON.FeatureCollection;
  lines: GeoJSON.FeatureCollection;
  tethers: GeoJSON.FeatureCollection;
  where: Map<string, [number, number]>;
}

function build(graph: GraphJSON, index: GraphIndex): Built {
  const where = new Map<string, [number, number]>();
  const ringCount = new Map<string, number>();
  const ringIndex = new Map<string, number>();
  for (const n of graph.nodes) if (typeof n.lat !== "number" && n.cityCode) ringCount.set(n.cityCode, (ringCount.get(n.cityCode) ?? 0) + 1);

  const points: GeoJSON.Feature[] = [];
  const tethers: GeoJSON.Feature[] = [];
  const perCity = new Map<string, Map<string, number>>();
  for (const n of graph.nodes) {
    if (n.type === "trip" || n.type === "route" || n.type === "country" || n.type === "leg") continue;
    let pos: [number, number] | null;
    if (typeof n.lat === "number" && typeof n.lon === "number") pos = [n.lon, n.lat];
    else {
      const i = ringIndex.get(n.cityCode ?? "") ?? 0;
      ringIndex.set(n.cityCode ?? "", i + 1);
      pos = placeNode(n, index, i, ringCount.get(n.cityCode ?? "") ?? 1, 0.12);
    }
    if (!pos) continue;
    where.set(n.id, pos);
    const always = ALWAYS.includes(n.type);
    const color = nodeColor(n.type, "globe", n.style);
    const radius = n.type === "activity" ? activityRadius(n.style.votes) / 3 : n.type === "city" ? 7 : n.type === "stop" ? 4 : 5.5;
    points.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: pos },
      properties: {
        id: n.id,
        type: n.type,
        label: n.type === "airport" ? String(n.attrs.code ?? n.label) : n.label,
        color,
        radius,
        always: always ? 1 : 0,
        hollow: (n.type === "activity" && !n.style.planned) || (n.type === "hotel" && n.style.status === "shortlist") ? 1 : 0,
        fixed: n.style.fixedDate ? 1 : 0,
      },
    });
    if (!always && n.cityCode) {
      const city = index.byId.get(`city:${n.cityCode}`);
      if (city && typeof city.lon === "number" && typeof city.lat === "number") {
        tethers.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[city.lon, city.lat], pos] }, properties: {} });
      }
      if (n.type !== "stop") {
        const m = perCity.get(n.cityCode) ?? new Map<string, number>();
        m.set(n.type, (m.get(n.type) ?? 0) + 1);
        perCity.set(n.cityCode, m);
      }
    }
  }

  // Count bubbles per city and type, shown when zoomed out.
  const bubbles: GeoJSON.Feature[] = [];
  for (const [code, counts] of perCity) {
    const city = index.byId.get(`city:${code}`);
    if (!city || typeof city.lon !== "number" || typeof city.lat !== "number") continue;
    [...counts].forEach(([type, count], i) => {
      const angle = -Math.PI / 2 + i * 0.9;
      bubbles.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [city.lon! + 1.4 * Math.cos(angle), city.lat! + 1.1 * Math.sin(angle)] },
        properties: { count: String(count), color: nodeColor(type as GraphNode["type"], "globe", { tag: "other" }), title: `${count} ${NODE_LABEL[type as GraphNode["type"]].toLowerCase()}` },
      });
    });
  }

  const lines: GeoJSON.Feature[] = [];
  for (const n of graph.nodes) {
    if (n.type !== "leg") continue;
    const outs = index.out.get(n.id) ?? [];
    const from = outs.find((e) => e.type === "FROM")?.target;
    const to = outs.find((e) => e.type === "TO")?.target;
    const a = from ? where.get(from) ?? placeOwn(index.byId.get(from)) : null;
    const b = to ? where.get(to) ?? placeOwn(index.byId.get(to)) : null;
    if (!a || !b) continue;
    const mode = String(n.style.mode ?? "train");
    const status = String(n.style.status ?? "idea");
    const kind = lineKind(mode);
    const color = (MODE_COLOR[mode] ?? MODE_COLOR.train!).globe;
    const opacity = STATUS_OPACITY[status] ?? 0.4;
    where.set(n.id, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    lines.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: kind === "arc" ? greatCircle(a, b) : [a, b] },
      properties: { id: n.id, kind, color, opacity },
    });
  }
  return {
    points: { type: "FeatureCollection", features: points },
    bubbles: { type: "FeatureCollection", features: bubbles },
    lines: { type: "FeatureCollection", features: lines },
    tethers: { type: "FeatureCollection", features: tethers },
    where,
  };
}

function placeOwn(n: GraphNode | undefined): [number, number] | null {
  return n && typeof n.lon === "number" && typeof n.lat === "number" ? [n.lon, n.lat] : null;
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export default function GlobeView({ graph, index, selected, step, camera, onSelect, onUnavailable }: GlobeProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const builtRef = useRef<Built | null>(null);
  const [loaded, setLoaded] = useState(false);
  const handlers = useRef({ onSelect, onUnavailable });
  handlers.current = { onSelect, onUnavailable };

  useEffect(() => {
    if (!container.current) return;
    if (!webglAvailable()) {
      handlers.current.onUnavailable("WebGL is not available in this browser.");
      return;
    }
    const map = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      center: [112, 18],
      zoom: 1.7,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");
    map.on("webglcontextlost", () => handlers.current.onUnavailable("The 3D view lost its graphics context."));
    map.on("style.load", () => {
      map.setProjection({ type: "globe" });
      map.addSource("g-tethers", { type: "geojson", data: empty });
      map.addSource("g-lines", { type: "geojson", data: empty });
      map.addSource("g-points", { type: "geojson", data: empty });
      map.addSource("g-bubbles", { type: "geojson", data: empty });
      map.addSource("g-selected", { type: "geojson", data: empty });
      map.addSource("g-step", { type: "geojson", data: empty });
      map.addLayer({ id: "g-tethers", type: "line", source: "g-tethers", minzoom: CLUSTER_BELOW, paint: { "line-color": "#C9CED6", "line-opacity": 0.25, "line-width": 1 } });
      map.addLayer({
        id: "g-lines-solid",
        type: "line",
        source: "g-lines",
        filter: ["==", ["get", "kind"], "solid"],
        layout: { "line-cap": "round" },
        paint: { "line-color": ["get", "color"], "line-opacity": ["get", "opacity"], "line-width": 3 },
      });
      map.addLayer({
        id: "g-lines-dotted",
        type: "line",
        source: "g-lines",
        filter: ["==", ["get", "kind"], "dotted"],
        layout: { "line-cap": "round" },
        paint: { "line-color": ["get", "color"], "line-opacity": ["get", "opacity"], "line-width": 2.5, "line-dasharray": [0.3, 1.8] },
      });
      map.addLayer({
        id: "g-lines-flight",
        type: "line",
        source: "g-lines",
        filter: ["==", ["get", "kind"], "arc"],
        paint: { "line-color": ["get", "color"], "line-opacity": ["get", "opacity"], "line-width": 2.2, "line-dasharray": [2, 1.5] },
      });
      map.addLayer({ id: "g-step", type: "line", source: "g-step", paint: { "line-color": "#F2C94C", "line-width": 6, "line-opacity": 0.55, "line-blur": 1 } });
      // Cities and hubs always show; everything else appears from zoom 4 (below that, count bubbles).
      const pointPaint = {
        "circle-radius": ["get", "radius"],
        "circle-color": ["case", ["==", ["get", "hollow"], 1], "#1B1C1F", ["get", "color"]],
        "circle-stroke-color": ["case", ["==", ["get", "fixed"], 1], FIXED_DATE.globe, ["==", ["get", "hollow"], 1], ["get", "color"], "#1B1C1F"],
        "circle-stroke-width": ["case", ["==", ["get", "fixed"], 1], 3, ["==", ["get", "hollow"], 1], 2.5, 1.5],
      } as maplibregl.CircleLayerSpecification["paint"];
      map.addLayer({ id: "g-points-items", type: "circle", source: "g-points", minzoom: CLUSTER_BELOW, filter: ["==", ["get", "always"], 0], paint: pointPaint });
      map.addLayer({ id: "g-points", type: "circle", source: "g-points", filter: ["==", ["get", "always"], 1], paint: pointPaint });
      const labelLayout = { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true, "text-max-width": 10 } as maplibregl.SymbolLayerSpecification["layout"];
      const labelPaint = { "text-color": "#F1F2F4", "text-halo-color": "#1B1C1F", "text-halo-width": 1.5 };
      map.addLayer({ id: "g-labels", type: "symbol", source: "g-points", filter: ["==", ["get", "type"], "city"], layout: labelLayout, paint: labelPaint });
      map.addLayer({ id: "g-labels-items", type: "symbol", source: "g-points", minzoom: 5, filter: ["!=", ["get", "type"], "city"], layout: labelLayout, paint: labelPaint });
      map.addLayer({
        id: "g-bubbles",
        type: "circle",
        source: "g-bubbles",
        maxzoom: CLUSTER_BELOW,
        paint: { "circle-radius": 9, "circle-color": ["get", "color"], "circle-stroke-color": "#1B1C1F", "circle-stroke-width": 1.5, "circle-opacity": 0.9 },
      });
      map.addLayer({
        id: "g-bubble-count",
        type: "symbol",
        source: "g-bubbles",
        maxzoom: CLUSTER_BELOW,
        layout: { "text-field": ["get", "count"], "text-font": ["Noto Sans Regular"], "text-size": 10, "text-allow-overlap": true },
        paint: { "text-color": "#1B1C1F" },
      });
      map.addLayer({ id: "g-selected", type: "circle", source: "g-selected", paint: { "circle-radius": 13, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#F2C94C", "circle-stroke-width": 3 } });

      const pick = (e: maplibregl.MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id;
        if (id) handlers.current.onSelect(String(id));
      };
      const clickable = ["g-points", "g-points-items", "g-lines-solid", "g-lines-dotted", "g-lines-flight"];
      for (const layer of clickable) map.on("click", layer, pick);
      for (const layer of clickable) {
        map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
      }

      setLoaded(true);
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Data.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const built = build(graph, index);
    builtRef.current = built;
    (map.getSource("g-points") as GeoJSONSource | undefined)?.setData(built.points);
    (map.getSource("g-bubbles") as GeoJSONSource | undefined)?.setData(built.bubbles);
    (map.getSource("g-lines") as GeoJSONSource | undefined)?.setData(built.lines);
    (map.getSource("g-tethers") as GeoJSONSource | undefined)?.setData(built.tethers);
  }, [graph, index, loaded]);

  // Selection: ring and fly-to.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const pos = selected ? builtRef.current?.where.get(selected) : undefined;
    (map.getSource("g-selected") as GeoJSONSource | undefined)?.setData(
      pos ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: pos }, properties: {} }] } : empty,
    );
    if (pos) {
      const zoom = Math.max(map.getZoom(), 5);
      if (reducedMotion()) map.jumpTo({ center: pos, zoom });
      else map.flyTo({ center: pos, zoom, speed: 1.2 });
    }
  }, [selected, loaded, graph]);

  // Journey step: highlight the leg and follow with the camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const built = builtRef.current;
    const legLine = step?.leg ? built?.lines.features.find((f) => f.properties?.id === step.leg!.id) : undefined;
    (map.getSource("g-step") as GeoJSONSource | undefined)?.setData(legLine ? { type: "FeatureCollection", features: [legLine] } : empty);
    const target = step ? (step.to ? built?.where.get(step.to.id) : undefined) ?? built?.where.get(step.stop.id) : undefined;
    if (target) {
      if (reducedMotion()) map.jumpTo({ center: target, zoom: 4.2 });
      else map.flyTo({ center: target, zoom: 4.2, speed: 0.9, curve: 1.4 });
    }
  }, [step, loaded]);

  // Camera presets.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !camera) return;
    map.fitBounds(camera.bounds as LngLatBoundsLike, { padding: 60, duration: reducedMotion() ? 0 : 900, maxZoom: 6 });
  }, [camera, loaded]);

  return (
    <div className="relative h-full w-full bg-board">
      <div ref={container} className="h-full w-full" data-testid="graph-globe" role="region" aria-label="Trip graph on a 3D globe" />
      <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-board/85 px-2 py-1 text-[11px] text-amber-soft">
        Flights: dashed great circles · rail solid · boat/road dotted
      </div>
    </div>
  );
}
