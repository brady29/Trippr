/**
 * The Map tab's "Stay prices" heat layer: H3 hexagons filled on the sequential ramp in lib/stay-cells.ts, under the areas,
 * activities and stop markers. Only import from components loaded with next/dynamic (ssr: false).
 */
import type maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { STAY_RAMP, type StayFeatureProps } from "@/lib/stay-cells";
import { EMPTY } from "./base";

export const STAY_SOURCE = "m-stay";
export const STAY_FILL = "m-stay-fill";
const STAY_OUTLINE = "m-stay-outline";
/** Layers drawn above the cells that should win a click. */
const POINT_LAYERS = ["m-act-planned", "m-act-ideas", "m-act-events", "m-places-icons", "m-clusters"];

/**
 * Adds the source and the two layers just under the basemap's first label layer, so street and place names stay readable
 * and the route lines, areas, activities and stop markers (all added later) sit on top.
 */
export function addStayLayers(m: maplibregl.Map) {
  const before = m.getStyle().layers.find((l) => l.type === "symbol")?.id;
  m.addSource(STAY_SOURCE, { type: "geojson", data: EMPTY });
  const colour = ["interpolate", ["linear"], ["get", "ratio"]] as unknown[];
  STAY_RAMP.forEach((c, i) => colour.push(i / (STAY_RAMP.length - 1), c));
  m.addLayer(
    {
      id: STAY_FILL,
      type: "fill",
      source: STAY_SOURCE,
      layout: { visibility: "none" },
      paint: { "fill-color": colour as unknown as maplibregl.ExpressionSpecification, "fill-opacity": 0.62 },
    },
    before,
  );
  m.addLayer(
    {
      id: STAY_OUTLINE,
      type: "line",
      source: STAY_SOURCE,
      layout: { visibility: "none" },
      paint: { "line-color": "#5b616b", "line-width": 0.6, "line-opacity": 0.35 },
    },
    before,
  );
}

export function setStayData(m: maplibregl.Map, data: GeoJSON.FeatureCollection | null, visible: boolean) {
  if (!m.getSource(STAY_SOURCE)) return;
  (m.getSource(STAY_SOURCE) as GeoJSONSource).setData(data ?? EMPTY);
  const visibility = visible ? "visible" : "none";
  for (const id of [STAY_FILL, STAY_OUTLINE]) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", visibility);
}

/** Calls `pick` with the properties of the cell under a click. */
export function onStayClick(m: maplibregl.Map, pick: (props: StayFeatureProps) => void) {
  m.on("mouseenter", STAY_FILL, () => (m.getCanvas().style.cursor = "pointer"));
  m.on("mouseleave", STAY_FILL, () => (m.getCanvas().style.cursor = ""));
  m.on("click", STAY_FILL, (e) => {
    // Activities and areas on top win the click; the cell only answers when nothing else was hit.
    const above = m.queryRenderedFeatures(e.point, { layers: POINT_LAYERS.filter((id) => m.getLayer(id)) });
    if (above.length) return;
    const props = e.features?.[0]?.properties as StayFeatureProps | undefined;
    if (props) pick(props);
  });
}
