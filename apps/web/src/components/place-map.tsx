"use client";

import maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";

const STYLE = process.env.NEXT_PUBLIC_MAP_STYLE ?? "https://tiles.openfreemap.org/styles/positron";

/** A small map with one draggable pin, for nudging an activity's location. */
export default function PlaceMap({
  lat,
  lon,
  label,
  onMove,
}: {
  lat: number;
  lon: number;
  label: string;
  onMove?: (point: { lat: number; lon: number }) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const moved = useRef(onMove);
  moved.current = onMove;

  useEffect(() => {
    if (!container.current) return;
    const m = new maplibregl.Map({ container: container.current, style: STYLE, center: [lon, lat], zoom: 15, attributionControl: { compact: true } });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    const pin = new maplibregl.Marker({ draggable: Boolean(moved.current), color: "#c2410c" }).setLngLat([lon, lat]).addTo(m);
    pin.getElement().setAttribute("aria-label", `Pin for ${label}`);
    pin.on("dragend", () => {
      const p = pin.getLngLat();
      moved.current?.({ lat: Number(p.lat.toFixed(6)), lon: Number(p.lng.toFixed(6)) });
    });
    map.current = m;
    marker.current = pin;
    return () => {
      m.remove();
      map.current = null;
      marker.current = null;
    };
    // The map is created once; position updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    marker.current?.setLngLat([lon, lat]);
    map.current?.easeTo({ center: [lon, lat] });
  }, [lat, lon]);

  return <div ref={container} className="h-48 w-full overflow-hidden rounded-lg border border-line" role="region" aria-label={`Map of ${label}`} />;
}
