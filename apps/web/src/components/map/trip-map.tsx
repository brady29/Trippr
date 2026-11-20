"use client";

/**
 * The Map tab's MapLibre canvas. Activities sit in a clustered GeoJSON
 * source (clusters below zoom 10); hotels, hubs and areas in a plain one;
 * route stops are numbered HTML markers. Shapes other than circles are
 * drawn on a canvas the first time a style asks for them
 * ("styleimagemissing"), one image per shape and colour.
 */
import type maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { ICON_PATHS } from "@/lib/graph-palette";
import { toFeatureCollections, type MapItem, type MapShape } from "@/lib/map-features";
import { addRouteLayers, createMap, EMPTY, fitTo, MAP_FONT, reducedMotion, stopMarker, webglAvailable } from "./base";

export type Bounds = [[number, number], [number, number]];

export interface TripMapProps {
  items: MapItem[];
  segments: GeoJSON.FeatureCollection;
  selected: string | null;
  /** The camera frames these points whenever the key changes. */
  fit: { key: string; points: [number, number][] } | null;
  /** A list row asked to fly to an item. */
  fly: { key: number; id: string } | null;
  onSelect(id: string): void;
  onView(bounds: Bounds): void;
  onUnavailable(reason: string): void;
}

const CLUSTER_MAX_ZOOM = 9;
const PAPER = "#FFFDF8";
const INK = "#0F151D";
const FOCUS = "#C4452A";
const ICON_SHAPES: MapShape[] = ["diamond", "square", "square-outline", "triangle", "plane"];
const ICON_PX = 40;

/** Draws one marker shape at 2x: filled in its colour with a light outline, so it holds on any tile. */
function drawIcon(shape: MapShape, color: string): ImageData | null {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ICON_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const c = ICON_PX / 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (shape === "square" || shape === "square-outline") ctx.rect(9, 9, 22, 22);
  else if (shape === "diamond") {
    ctx.moveTo(c, 4);
    ctx.lineTo(ICON_PX - 4, c);
    ctx.lineTo(c, ICON_PX - 4);
    ctx.lineTo(4, c);
    ctx.closePath();
  } else if (shape === "triangle") {
    ctx.moveTo(c, 6);
    ctx.lineTo(ICON_PX - 6, ICON_PX - 9);
    ctx.lineTo(6, ICON_PX - 9);
    ctx.closePath();
  } else ctx.arc(c, c, 14, 0, Math.PI * 2);

  if (shape === "square-outline") {
    ctx.fillStyle = PAPER;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = color;
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = PAPER;
    ctx.stroke();
  }
  if (shape === "plane" && typeof Path2D !== "undefined") {
    ctx.save();
    ctx.translate(c - 10, c - 10);
    ctx.scale(20 / 24, 20 / 24);
    ctx.fillStyle = PAPER;
    ctx.fill(new Path2D(ICON_PATHS.airport));
    ctx.restore();
  }
  return ctx.getImageData(0, 0, ICON_PX, ICON_PX);
}

const iconExpr = ["concat", ["get", "shape"], "|", ["get", "color"]] as unknown as maplibregl.ExpressionSpecification;

export default function TripMap({ items, segments, selected, fit, fly, onSelect, onView, onUnavailable }: TripMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const [loaded, setLoaded] = useState(false);
  const handlers = useRef({ onSelect, onView, onUnavailable });
  handlers.current = { onSelect, onView, onUnavailable };

  useEffect(() => {
    if (!container.current) return;
    if (!webglAvailable()) {
      handlers.current.onUnavailable("This browser can't draw the map (no WebGL). The list has everything on it.");
      return;
    }
    let m: maplibregl.Map;
    try {
      m = createMap(container.current);
    } catch {
      handlers.current.onUnavailable("The map couldn't start. The list has everything on it.");
      return;
    }
    const report = () => {
      const b = m.getBounds();
      handlers.current.onView([
        [b.getWest(), b.getSouth()],
        [b.getEast(), b.getNorth()],
      ]);
    };
    m.on("styleimagemissing", (e: { id: string }) => {
      const [shape, color] = e.id.split("|");
      if (!shape || !color || !ICON_SHAPES.includes(shape as MapShape) || m.hasImage(e.id)) return;
      const img = drawIcon(shape as MapShape, color);
      if (img) m.addImage(e.id, img, { pixelRatio: 2 });
    });
    m.on("load", () => {
      addRouteLayers(m, "route");
      m.addLayer(
        {
          id: "route-focus",
          type: "line",
          source: "route",
          filter: ["==", ["get", "focus"], 1],
          layout: { "line-cap": "round" },
          paint: { "line-color": "#FFC23D", "line-width": 9, "line-opacity": 0.6 },
        },
        "route-rail",
      );

      m.addSource("m-places", { type: "geojson", data: EMPTY });
      m.addSource("m-acts", { type: "geojson", data: EMPTY, cluster: true, clusterMaxZoom: CLUSTER_MAX_ZOOM, clusterRadius: 40 });
      m.addSource("m-selected", { type: "geojson", data: EMPTY });

      // Areas: translucent circles with a label, under everything else.
      m.addLayer({
        id: "m-areas",
        type: "circle",
        source: "m-places",
        filter: ["==", ["get", "shape"], "area"],
        paint: {
          "circle-radius": ["get", "radius"],
          "circle-color": ["get", "color"],
          "circle-opacity": 0.16,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 1.5,
          "circle-stroke-opacity": 0.6,
        },
      });
      m.addLayer({
        id: "m-area-labels",
        type: "symbol",
        source: "m-places",
        filter: ["==", ["get", "shape"], "area"],
        layout: { "text-field": ["get", "label"], "text-font": MAP_FONT, "text-size": 11, "text-optional": true, "text-max-width": 8 },
        paint: { "text-color": "#1B222B", "text-halo-color": PAPER, "text-halo-width": 1.5 },
      });
      m.addLayer({
        id: "m-places-icons",
        type: "symbol",
        source: "m-places",
        filter: ["!=", ["get", "shape"], "area"],
        layout: { "icon-image": iconExpr, "icon-allow-overlap": true, "icon-ignore-placement": true },
      });

      // Activities and their clusters.
      const single = ["!", ["has", "point_count"]] as maplibregl.ExpressionSpecification;
      m.addLayer({
        id: "m-clusters",
        type: "circle",
        source: "m-acts",
        filter: ["has", "point_count"],
        paint: {
          "circle-radius": ["step", ["get", "point_count"], 13, 10, 17, 40, 22],
          "circle-color": "#1B222B",
          "circle-stroke-color": PAPER,
          "circle-stroke-width": 2,
        },
      });
      m.addLayer({
        id: "m-cluster-count",
        type: "symbol",
        source: "m-acts",
        filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": MAP_FONT, "text-size": 11, "text-allow-overlap": true },
        paint: { "text-color": "#FFC23D" },
      });
      m.addLayer({
        id: "m-act-ideas",
        type: "circle",
        source: "m-acts",
        filter: ["all", single, ["==", ["get", "shape"], "ring"]],
        paint: {
          "circle-radius": ["get", "radius"],
          "circle-color": PAPER,
          "circle-opacity": 0.85,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 2.5,
        },
      });
      m.addLayer({
        id: "m-act-planned",
        type: "circle",
        source: "m-acts",
        filter: ["all", single, ["==", ["get", "shape"], "circle"]],
        paint: { "circle-radius": ["get", "radius"], "circle-color": ["get", "color"], "circle-stroke-color": PAPER, "circle-stroke-width": 1.5 },
      });
      m.addLayer({
        id: "m-act-events",
        type: "symbol",
        source: "m-acts",
        filter: ["all", single, ["==", ["get", "shape"], "diamond"]],
        layout: { "icon-image": iconExpr, "icon-allow-overlap": true, "icon-ignore-placement": true },
      });

      // Focus (from the assistant) and selection rings.
      const ring = (id: string, source: string, filter: maplibregl.FilterSpecification) =>
        m.addLayer({
          id,
          type: "circle",
          source,
          filter,
          paint: {
            "circle-radius": ["+", ["min", ["get", "radius"], 14], 6],
            "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-color": FOCUS,
            "circle-stroke-width": 2.5,
          },
        });
      ring("m-focus-acts", "m-acts", ["all", single, ["==", ["get", "focused"], 1]]);
      ring("m-focus-places", "m-places", ["all", ["==", ["get", "focused"], 1], ["!=", ["get", "shape"], "area"]]);
      m.addLayer({
        id: "m-selected",
        type: "circle",
        source: "m-selected",
        paint: { "circle-radius": 17, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": INK, "circle-stroke-width": 3 },
      });

      const pick = (e: maplibregl.MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id;
        if (id) handlers.current.onSelect(String(id));
      };
      const clickable = ["m-act-planned", "m-act-ideas", "m-act-events", "m-places-icons", "m-areas"];
      for (const layer of [...clickable, "m-clusters"]) {
        m.on("mouseenter", layer, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", layer, () => (m.getCanvas().style.cursor = ""));
      }
      for (const layer of clickable) m.on("click", layer, pick);
      m.on("click", "m-clusters", async (e) => {
        const f = e.features?.[0];
        const clusterId = f?.properties?.cluster_id;
        if (clusterId == null || f?.geometry.type !== "Point") return;
        try {
          const zoom = await (m.getSource("m-acts") as GeoJSONSource).getClusterExpansionZoom(clusterId);
          m.easeTo({ center: f.geometry.coordinates as [number, number], zoom, duration: reducedMotion() ? 0 : 500 });
        } catch {
          // The cluster went away while zooming; nothing to do.
        }
      });
      m.on("moveend", report);
      report();
      setLoaded(true);
    });
    m.on("webglcontextlost", () => handlers.current.onUnavailable("The map lost its graphics context. The list has everything on it."));
    map.current = m;
    return () => {
      markers.current.forEach((mk) => mk.remove());
      markers.current = [];
      m.remove();
      map.current = null;
    };
  }, []);

  // Data: points, route lines and stop markers.
  useEffect(() => {
    const m = map.current;
    if (!m || !loaded) return;
    const { activities, places } = toFeatureCollections(items);
    (m.getSource("m-acts") as GeoJSONSource | undefined)?.setData(activities);
    (m.getSource("m-places") as GeoJSONSource | undefined)?.setData(places);
    (m.getSource("route") as GeoJSONSource | undefined)?.setData(segments);
    markers.current.forEach((mk) => mk.remove());
    markers.current = items
      .filter((i) => i.type === "stop")
      .map((i) =>
        stopMarker(
          m,
          { n: i.n ?? 0, name: i.cityName ?? i.label, code: i.cityCode, lat: i.lat, lon: i.lon },
          () => handlers.current.onSelect(i.id),
          i.focused || i.id === selected,
        ),
      );
  }, [items, segments, selected, loaded]);

  // Selection ring.
  useEffect(() => {
    const m = map.current;
    if (!m || !loaded) return;
    const item = selected ? items.find((i) => i.id === selected && i.type !== "stop") : undefined;
    (m.getSource("m-selected") as GeoJSONSource | undefined)?.setData(
      item ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [item.lon, item.lat] }, properties: {} }] } : EMPTY,
    );
  }, [selected, items, loaded]);

  // Camera: frame the view when the route, day or focus changes.
  const fitKey = fit?.key;
  const fitPoints = useRef(fit?.points ?? []);
  fitPoints.current = fit?.points ?? [];
  useEffect(() => {
    const m = map.current;
    if (!m || !loaded || !fitKey) return;
    fitTo(m, fitPoints.current, { padding: 56, maxZoom: 12 });
  }, [fitKey, loaded]);

  // Camera: fly to a row picked in the list.
  const flyKey = fly?.key;
  const flyItems = useRef(items);
  flyItems.current = items;
  useEffect(() => {
    const m = map.current;
    if (!m || !loaded || !fly) return;
    const item = flyItems.current.find((i) => i.id === fly.id);
    if (!item) return;
    const zoom = Math.max(m.getZoom(), item.type === "stop" ? 9 : 13);
    if (reducedMotion()) m.jumpTo({ center: [item.lon, item.lat], zoom });
    else m.flyTo({ center: [item.lon, item.lat], zoom, speed: 1.4 });
    // Only a new request should move the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyKey, loaded]);

  return <div ref={container} className="h-full w-full" data-testid="map-canvas" />;
}
