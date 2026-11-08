"use client";

import type { StopView } from "@trippr/contracts";
import maplibregl, { type GeoJSONSource, type LngLatLike } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

const STYLE = process.env.NEXT_PUBLIC_MAP_STYLE ?? "https://tiles.openfreemap.org/styles/positron";

type Kind = "rail" | "flight" | "other";
const kindOf = (mode: string): Kind => (mode === "hsr" || mode === "train" ? "rail" : mode === "flight" ? "flight" : "other");

/** Flights draw as a gentle arc so they read differently from rail even without colour. */
function arc(a: [number, number], b: [number, number], steps = 24): [number, number][] {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const bend = 0.18;
  const cx = (x1 + x2) / 2 - dy * bend;
  const cy = (y1 + y2) / 2 + dx * bend;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return [(1 - t) ** 2 * x1 + 2 * (1 - t) * t * cx + t ** 2 * x2, (1 - t) ** 2 * y1 + 2 * (1 - t) * t * cy + t ** 2 * y2];
  });
}

function segments(stops: StopView[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let i = 1; i < stops.length; i++) {
    const from = stops[i - 1]!;
    const to = stops[i]!;
    const a: [number, number] = [from.city.lon, from.city.lat];
    const b: [number, number] = [to.city.lon, to.city.lat];
    const kind = kindOf(to.arriveMode);
    features.push({
      type: "Feature",
      properties: { kind, mode: to.arriveMode },
      geometry: { type: "LineString", coordinates: kind === "flight" ? arc(a, b) : [a, b] },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * The route on a real map: solid lines for trains, dashed arcs for flights,
 * dotted lines for boats and roads. Markers jump to the matching stop card.
 */
export default function RouteMap({ stops }: { stops: StopView[] }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      center: [112, 18],
      zoom: 2.4,
      attributionControl: { compact: true },
      cooperativeGestures: true,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      m.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: "route-rail",
        type: "line",
        source: "route",
        filter: ["==", ["get", "kind"], "rail"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#2e7a59", "line-width": 3.5 },
      });
      m.addLayer({
        id: "route-flight",
        type: "line",
        source: "route",
        filter: ["==", ["get", "kind"], "flight"],
        layout: { "line-cap": "butt" },
        paint: { "line-color": "#3867c8", "line-width": 2.25, "line-dasharray": [3, 2] },
      });
      m.addLayer({
        id: "route-other",
        type: "line",
        source: "route",
        filter: ["==", ["get", "kind"], "other"],
        layout: { "line-cap": "round" },
        paint: { "line-color": "#8a6d3b", "line-width": 2.5, "line-dasharray": [0.4, 1.6] },
      });
      setLoaded(true);
    });
    map.current = m;
    return () => {
      markers.current.forEach((mk) => mk.remove());
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !loaded) return;
    (m.getSource("route") as GeoJSONSource | undefined)?.setData(segments(stops));
    markers.current.forEach((mk) => mk.remove());
    markers.current = stops.map((s, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className =
        "grid h-5 w-5 place-items-center rounded-full bg-[#0f151d] font-mono text-[10px] font-semibold text-[#ffc23d] shadow ring-2 ring-white";
      el.textContent = String(i + 1);
      el.title = `${i + 1}. ${s.city.name} (${s.city.code})`;
      el.setAttribute("aria-label", `Stop ${i + 1}: ${s.city.name}`);
      el.onclick = () => document.getElementById(`stop-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return new maplibregl.Marker({ element: el }).setLngLat([s.city.lon, s.city.lat] as LngLatLike).addTo(m);
    });
    if (stops.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      stops.forEach((s) => bounds.extend([s.city.lon, s.city.lat]));
      m.fitBounds(bounds, { padding: 48, maxZoom: 6, duration: 600 });
    }
  }, [stops, loaded]);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-paper-2">
      <div ref={container} className="h-64 w-full sm:h-80" role="region" aria-label="Map of the route" />
      <div className="pointer-events-none absolute bottom-2 left-2 flex gap-3 rounded-md bg-card/90 px-2 py-1 text-[11px] text-ink-soft">
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-5 bg-rail" /> train
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-5 border-t-2 border-dashed border-sky" /> flight
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-5 border-t-2 border-dotted border-[#8a6d3b]" /> boat / road
        </span>
      </div>
    </div>
  );
}
