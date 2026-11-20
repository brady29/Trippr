/**
 * The Map tab's pure logic: graph nodes and route stops in, filtered map
 * items and GeoJSON out. No browser or MapLibre here, so it runs in unit tests.
 */
import type { Activity, GraphJSON, GraphNode, GraphNodeType } from "@trippr/contracts";
import type { Itinerary, PlaceStatus, When } from "@trippr/rules";
import { activityRadius, NODE_FILL, nodeColor, NODE_LABEL } from "./graph-palette";

export const MAP_LAYERS = ["route", "planned", "ideas", "events", "hotels", "hubs", "areas"] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

export const MAP_LAYER_LABEL: Record<MapLayer, string> = {
  route: "Route",
  planned: "Activities planned",
  ideas: "Activity ideas",
  events: "Fixed-date events",
  hotels: "Hotels",
  hubs: "Stations and airports",
  areas: "Areas",
};

/** Shape is the second channel: never colour alone. */
export type MapShape = "stop" | "circle" | "ring" | "diamond" | "square" | "square-outline" | "triangle" | "plane" | "area";

/** MapLibre GeoJSON sources stay fast well past this; clustering covers the rest. */
export const MAX_FEATURES = 500;

export interface MapItem {
  /** Graph node id ("act:act-liziba", "hotel:h_2"); route stops use "stop:<stopId>". */
  id: string;
  type: GraphNodeType;
  layer: MapLayer;
  label: string;
  lon: number;
  lat: number;
  color: string;
  shape: MapShape;
  /** Circle radius in px (activities and areas). */
  radius: number;
  cityCode?: string;
  cityName?: string;
  tags: string[];
  votes: number;
  /** Hotel stay status or leg status. */
  status?: string;
  /** Route stops: 1-based position. */
  n?: number;
  focused: boolean;
}

/** The parts of a route stop the map needs (a StopView fits). */
export interface RouteStopLike {
  id: string;
  arriveMode: string;
  city: { code: string; name: string; lat: number; lon: number };
}

const hasCoords = (n: { lat?: number; lon?: number }): n is { lat: number; lon: number } =>
  typeof n.lat === "number" && typeof n.lon === "number" && Number.isFinite(n.lat) && Number.isFinite(n.lon);

/** Which toggle a graph node sits under; null for nodes the map never draws as points. */
export function layerOf(n: GraphNode): MapLayer | null {
  switch (n.type) {
    case "activity":
      return n.style.fixedDate ? "events" : n.style.planned ? "planned" : "ideas";
    case "hotel":
      return "hotels";
    case "station":
    case "airport":
      return "hubs";
    case "area":
      return "areas";
    default:
      return null;
  }
}

/** Booked and chosen hotels are filled squares; shortlisted ones are outlines. */
export function shapeOf(n: GraphNode): MapShape {
  switch (n.type) {
    case "activity":
      return n.style.fixedDate ? "diamond" : n.style.planned ? "circle" : "ring";
    case "hotel":
      return n.style.status === "booked" || n.style.status === "chosen" ? "square" : "square-outline";
    case "station":
      return "triangle";
    case "airport":
      return "plane";
    case "area":
      return "area";
    default:
      return "circle";
  }
}

function radiusOf(n: GraphNode): number {
  if (n.type === "activity") return n.style.planned && !n.style.fixedDate ? 7 : Math.round(activityRadius(n.style.votes) / 2);
  if (n.type === "area") return 28;
  return 8;
}

// --- focus (?focus=) -------------------------------------------------------------

const FOCUS_ID = /^[a-z]{2,8}:[^\s,]{1,80}$/;

/** Comma-separated graph node ids; junk and duplicates are dropped, at most 50 kept. */
export function parseFocus(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => FOCUS_ID.test(s));
  return [...new Set(ids)].slice(0, 50);
}

export interface FocusScope {
  /** Every id asked for. */
  requested: string[];
  /** How many of those could be shown. */
  found: number;
  /** Point items to keep and ring. */
  nodeIds: Set<string>;
  /** Route stops to keep. */
  stopIds: Set<string>;
  /** Route segments (by destination stop) to highlight: the focused legs. */
  segmentStopIds: Set<string>;
  /** Where to fit the camera. */
  points: [number, number][];
}

/**
 * Turns focus ids into things on the map. Legs resolve to their two hubs
 * and the route segment they belong to; unknown or unplaced ids are ignored.
 */
export function resolveFocus(ids: string[], graph: GraphJSON | undefined, stops: RouteStopLike[]): FocusScope {
  const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
  const stopById = new Map(stops.map((s) => [`stop:${s.id}`, s]));
  const scope: FocusScope = { requested: ids, found: 0, nodeIds: new Set(), stopIds: new Set(), segmentStopIds: new Set(), points: [] };
  for (const id of ids) {
    const stop = stopById.get(id);
    if (stop) {
      scope.found++;
      scope.stopIds.add(stop.id);
      scope.points.push([stop.city.lon, stop.city.lat]);
      continue;
    }
    const n = byId.get(id);
    if (!n) continue;
    if (n.type === "leg") {
      const ends = [n.attrs.from, n.attrs.to].map((e) => byId.get(String(e))).filter((e): e is GraphNode => Boolean(e && hasCoords(e)));
      if (!ends.length) continue;
      scope.found++;
      for (const e of ends) {
        scope.nodeIds.add(e.id);
        scope.points.push([e.lon!, e.lat!]);
      }
      if (n.attrs.stopId) scope.segmentStopIds.add(String(n.attrs.stopId));
      continue;
    }
    if (!hasCoords(n) || (layerOf(n) === null && n.type !== "city")) continue;
    scope.found++;
    scope.nodeIds.add(n.id);
    scope.points.push([n.lon, n.lat]);
    if (n.type === "city") for (const s of stops) if (s.city.code === n.cityCode) scope.stopIds.add(s.id);
  }
  return scope;
}

// --- day filter (?day=) ----------------------------------------------------------

export interface DayScope {
  date: string;
  /** Planned activities, legs and their hubs, and the night's hotel. */
  nodeIds: Set<string>;
  /** Route stops to show as markers: where you sleep and both ends of the day's travel. */
  stopIds: Set<string>;
  /** Route segments (by destination stop) travelled that day. */
  travelStopIds: Set<string>;
}

/**
 * One itinerary day: the stop you sleep at, what's planned that day and the
 * travel that day. Null when the date isn't on the route.
 */
export function dayScope(itinerary: Itinerary, date: string, graph?: GraphJSON): DayScope | null {
  const day = itinerary.days.find((d) => d.date === date);
  if (!day) return null;
  const order = itinerary.stops.map((s) => s.stopId);
  const travelStopIds = new Set<string>(day.legs.map((l) => l.stopId));
  for (const s of itinerary.stops) if (s.days[0]?.date === date && order.indexOf(s.stopId) > 0) travelStopIds.add(s.stopId);

  const stopIds = new Set<string>(day.stopId ? [day.stopId] : []);
  for (const id of travelStopIds) {
    stopIds.add(id);
    const prev = order[order.indexOf(id) - 1];
    if (prev) stopIds.add(prev);
  }

  const nodeIds = new Set<string>(day.items.map((i) => `act:${i.activityId}`));
  const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
  for (const leg of day.legs) {
    const id = `leg:${leg.id}`;
    nodeIds.add(id);
    const n = byId.get(id);
    if (n?.attrs.from) nodeIds.add(String(n.attrs.from));
    if (n?.attrs.to) nodeIds.add(String(n.attrs.to));
  }
  if (day.stopId && graph) {
    for (const e of graph.edges) {
      if (e.type === "STAYS_AT" && e.source === `stop:${day.stopId}` && (e.attrs?.status === "booked" || e.attrs?.status === "chosen")) {
        nodeIds.add(e.target);
      }
    }
  }
  return { date, nodeIds, stopIds, travelStopIds };
}

/** "Day 12 · Chongqing" options for the day picker. */
export function dayOptions(itinerary: Itinerary | null): { date: string; label: string }[] {
  return (itinerary?.days ?? []).map((d) => ({ date: d.date, label: `Day ${d.index} · ${d.cityName ?? "Heading home"}` }));
}

// --- items -----------------------------------------------------------------------

export interface MapFilters {
  layers: ReadonlySet<MapLayer>;
  search?: string;
  day?: DayScope | null;
  /** Ignored when nothing in it could be found. */
  focus?: FocusScope | null;
}

export interface MapItems {
  /** In reading order: route order by city, then layer, then label. */
  items: MapItem[];
  /** Activities in the graph with no pin yet. */
  unplaced: number;
  /** True when items were dropped to stay under MAX_FEATURES. */
  truncated: boolean;
}

const LAYER_ORDER: MapLayer[] = ["route", "events", "planned", "ideas", "hotels", "areas", "hubs"];

/** Keep focused, then the route, then planned things, then the most-voted ideas. */
function rank(i: MapItem): number {
  if (i.focused) return 0;
  if (i.layer === "route") return 1;
  if (i.layer === "planned" || i.layer === "events" || i.layer === "hubs") return 2;
  if (i.layer === "hotels" && i.shape === "square") return 2;
  return 3;
}

export function buildMapItems(graph: GraphJSON | undefined, stops: RouteStopLike[], f: MapFilters): MapItems {
  const cityName = new Map<string, string>();
  const cityRank = new Map<string, number>();
  stops.forEach((s, i) => {
    cityName.set(s.city.code, s.city.name);
    if (!cityRank.has(s.city.code)) cityRank.set(s.city.code, i);
  });
  for (const n of graph?.nodes ?? []) if (n.type === "city" && n.cityCode && !cityName.has(n.cityCode)) cityName.set(n.cityCode, n.label);

  const focus = f.focus && f.focus.found > 0 ? f.focus : null;
  const q = (f.search ?? "").trim().toLowerCase();
  const matches = (i: MapItem) => !q || i.label.toLowerCase().includes(q) || (i.cityName ?? "").toLowerCase().includes(q);

  const all: MapItem[] = [];
  if (f.layers.has("route")) {
    stops.forEach((s, i) => {
      if (f.day && !f.day.stopIds.has(s.id)) return;
      if (focus && !focus.stopIds.has(s.id)) return;
      all.push({
        id: `stop:${s.id}`,
        type: "stop",
        layer: "route",
        label: `${i + 1}. ${s.city.name}`,
        lon: s.city.lon,
        lat: s.city.lat,
        color: NODE_FILL.trip.paper,
        shape: "stop",
        radius: 10,
        cityCode: s.city.code,
        cityName: s.city.name,
        tags: [],
        votes: 0,
        n: i + 1,
        focused: Boolean(focus?.stopIds.has(s.id)),
      });
    });
  }

  let unplaced = 0;
  for (const n of graph?.nodes ?? []) {
    const layer = layerOf(n);
    if (!layer) continue;
    if (!hasCoords(n)) {
      if (n.type === "activity") unplaced++;
      continue;
    }
    if (!f.layers.has(layer)) continue;
    if (f.day && !f.day.nodeIds.has(n.id)) continue;
    if (focus && !focus.nodeIds.has(n.id)) continue;
    all.push({
      id: n.id,
      type: n.type,
      layer,
      label: n.label,
      lon: n.lon,
      lat: n.lat,
      color: nodeColor(n.type, "paper", n.style),
      shape: shapeOf(n),
      radius: radiusOf(n),
      cityCode: n.cityCode,
      cityName: n.cityCode ? cityName.get(n.cityCode) : undefined,
      tags: n.style.tags ?? [],
      votes: n.style.votes ?? 0,
      status: n.style.status,
      focused: Boolean(focus?.nodeIds.has(n.id)),
    });
  }

  let items = all.filter(matches);
  const truncated = items.length > MAX_FEATURES;
  if (truncated) {
    items = items
      .map((item, i) => ({ item, i }))
      .sort((a, b) => rank(a.item) - rank(b.item) || b.item.votes - a.item.votes || a.i - b.i)
      .slice(0, MAX_FEATURES)
      .map((x) => x.item);
  }
  // Stops by their place on the route; everything else with the first stop in its city.
  const pos = (i: MapItem) => (i.n ? i.n - 1 : (cityRank.get(i.cityCode ?? "") ?? Number.MAX_SAFE_INTEGER));
  items.sort(
    (a, b) =>
      pos(a) - pos(b) ||
      LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer) ||
      a.label.localeCompare(b.label),
  );
  return { items, unplaced, truncated };
}

/** One line for screen readers and the list: what it is, where, and its key facts. */
export function describeItem(i: MapItem): string {
  const parts = [i.label, i.layer === "route" ? "route stop" : itemKind(i)];
  if (i.cityName && i.layer !== "route") parts.push(i.cityName);
  if (i.tags.length) parts.push(i.tags.join(", "));
  if (i.votes) parts.push(`${i.votes} vote${Math.abs(i.votes) === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/** "Activity idea", "Hotel, booked", "Station". */
export function itemKind(i: MapItem): string {
  if (i.type === "activity") return i.layer === "events" ? "Fixed-date event" : i.layer === "planned" ? "Activity, planned" : "Activity idea";
  if (i.type === "hotel") return i.status ? `Hotel, ${i.status === "shortlist" ? "shortlisted" : i.status}` : "Hotel";
  return NODE_LABEL[i.type];
}

// --- GeoJSON -----------------------------------------------------------------------

/** Activities go to a clustered source; hotels, hubs and areas to a plain one. Stops are HTML markers. */
export function toFeatureCollections(items: MapItem[]): { activities: GeoJSON.FeatureCollection; places: GeoJSON.FeatureCollection } {
  const activities: GeoJSON.Feature[] = [];
  const places: GeoJSON.Feature[] = [];
  for (const i of items) {
    if (i.type === "stop") continue;
    const feature: GeoJSON.Feature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [i.lon, i.lat] },
      properties: { id: i.id, type: i.type, layer: i.layer, label: i.label, color: i.color, shape: i.shape, radius: i.radius, focused: i.focused ? 1 : 0 },
    };
    (i.type === "activity" ? activities : places).push(feature);
  }
  return { activities: { type: "FeatureCollection", features: activities }, places: { type: "FeatureCollection", features: places } };
}

type Kind = "rail" | "flight" | "other";
export const routeKind = (mode: string): Kind => (mode === "hsr" || mode === "train" ? "rail" : mode === "flight" ? "flight" : "other");

/** Flights draw as a gentle arc so they read differently from rail even without colour. */
export function arc(a: [number, number], b: [number, number], steps = 24): [number, number][] {
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

/**
 * Route lines between consecutive stops, one per destination stop. `only`
 * keeps the segments into those stops; `highlight` marks them with focus = 1.
 */
export function routeSegments(
  stops: RouteStopLike[],
  opts: { only?: ReadonlySet<string> | null; highlight?: ReadonlySet<string> | null } = {},
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let i = 1; i < stops.length; i++) {
    const from = stops[i - 1]!;
    const to = stops[i]!;
    if (opts.only && !opts.only.has(to.id)) continue;
    const a: [number, number] = [from.city.lon, from.city.lat];
    const b: [number, number] = [to.city.lon, to.city.lat];
    const kind = routeKind(to.arriveMode);
    features.push({
      type: "Feature",
      properties: { kind, mode: to.arriveMode, stopId: to.id, focus: opts.highlight?.has(to.id) ? 1 : 0 },
      geometry: { type: "LineString", coordinates: kind === "flight" ? arc(a, b) : [a, b] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** [[west, south], [east, north]], or null with nothing to frame. */
export function boundsOf(points: [number, number][]): [[number, number], [number, number]] | null {
  if (!points.length) return null;
  let [w, s] = points[0]!;
  let [e, n] = points[0]!;
  for (const [x, y] of points) {
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  }
  return [
    [w, s],
    [e, n],
  ];
}

/** True when a point sits inside [[west, south], [east, north]]. */
export function inBounds([x, y]: [number, number], b: [[number, number], [number, number]]): boolean {
  const [[w, s], [e, n]] = b;
  const lonOk = w <= e ? x >= w && x <= e : x >= w || x <= e;
  return lonOk && y >= s && y <= n;
}

// --- activities from graph nodes ----------------------------------------------------

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** An Activity rebuilt from an activity node, enough for PlaceLinks and PlaceEditor. */
export function activityFromNode(n: GraphNode, cityName = ""): Activity {
  const a = n.attrs;
  return {
    id: n.id.replace(/^act:/, ""),
    title: n.label,
    when: (a.when as When | null | undefined) ?? null,
    costCad: typeof a.costCad === "number" ? a.costCad : null,
    url: str(a.url),
    mapsQuery: str(a.mapsQuery),
    tags: Array.isArray(a.tags) ? (a.tags as string[]) : (n.style.tags ?? []),
    cityCode: n.cityCode ?? "",
    cityName,
    countryIso: str(a.countryIso),
    website: str(a.website),
    ticketUrl: str(a.ticketUrl),
    reserveUrl: str(a.reserveUrl),
    mapsUrl: str(a.mapsUrl),
    address: str(a.address),
    lat: typeof n.lat === "number" ? n.lat : null,
    lon: typeof n.lon === "number" ? n.lon : null,
    placeStatus: (str(a.placeStatus) as PlaceStatus | null) ?? "unplaced",
    votes: n.style.votes ?? 0,
    myVote: 0,
    commentCount: typeof a.commentCount === "number" ? a.commentCount : 0,
  };
}
