"use client";

import type { StopView } from "@trippr/contracts";
import type maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { routeSegments } from "@/lib/map-features";
import { addRouteLayers, createMap, fitTo, stopMarker } from "./map/base";

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
    const m = createMap(container.current);
    m.on("load", () => {
      addRouteLayers(m, "route");
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
    (m.getSource("route") as GeoJSONSource | undefined)?.setData(routeSegments(stops));
    markers.current.forEach((mk) => mk.remove());
    markers.current = stops.map((s, i) =>
      stopMarker(m, { n: i + 1, name: s.city.name, code: s.city.code, lat: s.city.lat, lon: s.city.lon }, () =>
        document.getElementById(`stop-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }),
      ),
    );
    fitTo(
      m,
      stops.map((s) => [s.city.lon, s.city.lat]),
      { padding: 48, maxZoom: 6 },
    );
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
