import { createHash } from "node:crypto";
import {
  GRAPH_LIMITS,
  type GraphEdge,
  type GraphEdgeType,
  type GraphJSON,
  type GraphNode,
  type GraphNodeType,
  type GraphScope,
  type Hub,
} from "@trippr/contracts";
import { isFixedDate } from "@trippr/rules";
import type { Repositories } from "../repositories";

/** Activity colour tag: the first tag in this order, else "other". */
export const TAG_ORDER = ["sport", "tech", "nature", "culture", "food"] as const;
export const primaryTag = (tags: string[]) => TAG_ORDER.find((t) => tags.includes(t)) ?? "other";

export const nodeId = {
  trip: (id: string) => `trip:${id}`,
  route: (id: string) => `route:${id}`,
  stop: (id: string) => `stop:${id}`,
  city: (code: string) => `city:${code}`,
  country: (iso: string) => `country:${iso}`,
  activity: (id: string) => `act:${id}`,
  area: (id: string) => `area:${id}`,
  hotel: (id: string) => `hotel:${id}`,
  hub: (h: Pick<Hub, "kind" | "id">) => `${h.kind === "airport" ? "apt" : "stn"}:${h.id}`,
  leg: (id: string) => `leg:${id}`,
};

const MODE_WORD: Record<string, string> = {
  flight: "Flight",
  hsr: "High-speed train",
  train: "Train",
  maglev: "Maglev",
  boat: "Boat",
  road: "Road",
};

/**
 * When a graph is over the limits, keep the route skeleton first, then
 * planned things and the journey, then the rest of the libraries.
 */
const PRIORITY: ((n: GraphNode) => boolean)[] = [
  (n) => n.type === "trip" || n.type === "route" || n.type === "stop",
  (n) => n.type === "city" || n.type === "country",
  (n) => n.type === "leg" || n.type === "station" || n.type === "airport",
  (n) => n.type === "activity" && Boolean(n.style.planned),
  (n) => n.type === "hotel" && Boolean(n.style.planned),
  (n) => n.type === "area",
  (n) => n.type === "hotel",
  () => true,
];

export interface GraphLimits {
  nodes: number;
  edges: number;
}

export function truncate(nodes: GraphNode[], edges: GraphEdge[], limits: GraphLimits = GRAPH_LIMITS) {
  let truncated = false;
  let kept = nodes;
  if (nodes.length > limits.nodes) {
    truncated = true;
    const ranked = nodes
      .map((n, i) => ({ n, i, rank: PRIORITY.findIndex((p) => p(n)) }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .slice(0, limits.nodes)
      .sort((a, b) => a.i - b.i);
    kept = ranked.map((r) => r.n);
  }
  const ids = new Set(kept.map((n) => n.id));
  let keptEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  if (keptEdges.length > limits.edges) {
    truncated = true;
    keptEdges = keptEdges.slice(0, limits.edges);
  }
  return { nodes: kept, edges: keptEdges, truncated };
}

export interface GraphRequest {
  tripId: string;
  userId: string;
  scope: GraphScope;
  routeId?: string | null;
  city?: string | null;
  types?: GraphNodeType[];
}

/**
 * One graph export feeds both the 2D viewer and the 3D globe. Activities,
 * areas and hotels come from the same library queries the rest of the app
 * uses; the skeleton and legs come from the graph queries (G0, G1, G4).
 */
export async function buildGraph(
  repos: Repositories,
  req: GraphRequest,
  limits: GraphLimits = GRAPH_LIMITS,
): Promise<GraphJSON | null> {
  const meta0 = await repos.graph.trip(req.tripId);
  if (!meta0) return null;
  const routeFilter = req.scope === "route" ? (req.routeId ?? meta0.routes.find((r) => r.isCurrent)?.id ?? null) : null;
  const cityFilter = req.scope === "city" ? (req.city ?? null) : null;

  const [skeleton, legRows, activities, areas, hotels] = await Promise.all([
    repos.graph.skeleton(req.tripId, routeFilter, cityFilter),
    repos.graph.legs(req.tripId, routeFilter),
    repos.activities.list(req.tripId, req.userId, cityFilter ? { cityCode: cityFilter } : {}),
    repos.explorer.listAreas(req.tripId, req.userId, cityFilter ? { city: cityFilter } : {}),
    repos.explorer.listHotels(req.tripId, req.userId, cityFilter ? { city: cityFilter } : {}),
  ]);
  const cityHubs =
    cityFilter != null ? await repos.explorer.searchHubs({ q: "", city: cityFilter, limit: 50 }) : ([] as Hub[]);

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addNode = (n: GraphNode) => {
    const existing = nodes.get(n.id);
    if (existing) {
      const routes = [...new Set([...(existing.style.routes ?? []), ...(n.style.routes ?? [])])];
      if (routes.length) existing.style.routes = routes;
      return existing;
    }
    nodes.set(n.id, n);
    return n;
  };
  const addEdge = (type: GraphEdgeType, source: string, target: string, attrs?: Record<string, unknown>) => {
    const id = `${type}:${source}->${target}`;
    if (!edges.has(id)) edges.set(id, { id, type, source, target, ...(attrs ? { attrs } : {}) });
  };

  // Trip and routes.
  const routesInScope = meta0.routes.filter((r) =>
    routeFilter ? r.id === routeFilter : cityFilter ? skeleton.some((s) => s.routeId === r.id) : true,
  );
  if (req.scope === "trip") {
    addNode({ id: nodeId.trip(req.tripId), type: "trip", label: meta0.trip.name, attrs: { startDate: meta0.trip.startDate }, style: {} });
  }
  for (const r of routesInScope) {
    addNode({
      id: nodeId.route(r.id),
      type: "route",
      label: r.name,
      attrs: { isCurrent: r.isCurrent, version: r.version },
      style: { routes: [r.id] },
    });
    if (req.scope === "trip") addEdge("HAS_ROUTE", nodeId.trip(req.tripId), nodeId.route(r.id));
  }

  // Stops, cities, countries; NEXT edges along each route.
  const stopCity = new Map<string, string>();
  const stopRoute = new Map<string, string>();
  let previous: { routeId: string; stopId: string } | null = null;
  for (const row of skeleton) {
    const stopNode = nodeId.stop(row.stop.id);
    stopCity.set(row.stop.id, row.city.code);
    stopRoute.set(row.stop.id, row.routeId);
    addNode({
      id: stopNode,
      type: "stop",
      label: `${row.stop.order + 1}. ${row.city.name}`,
      lat: row.city.lat,
      lon: row.city.lon,
      cityCode: row.city.code,
      attrs: { routeId: row.routeId, routeName: row.routeName, order: row.stop.order, nights: row.stop.nights, arriveMode: row.stop.arriveMode },
      style: { routes: [row.routeId], mode: row.stop.arriveMode ?? undefined },
    });
    addNode({
      id: nodeId.city(row.city.code),
      type: "city",
      label: row.city.name,
      lat: row.city.lat,
      lon: row.city.lon,
      cityCode: row.city.code,
      attrs: { code: row.city.code, countryIso: row.country.iso },
      style: { color: row.country.color ?? undefined, routes: [row.routeId] },
    });
    addNode({
      id: nodeId.country(row.country.iso),
      type: "country",
      label: row.country.name,
      attrs: { iso: row.country.iso },
      style: { color: row.country.color ?? undefined, routes: [row.routeId] },
    });
    addEdge("HAS_STOP", nodeId.route(row.routeId), stopNode, { order: row.stop.order });
    addEdge("AT", stopNode, nodeId.city(row.city.code));
    addEdge("IN", nodeId.city(row.city.code), nodeId.country(row.country.iso));
    if (!cityFilter && previous && previous.routeId === row.routeId) addEdge("NEXT", nodeId.stop(previous.stopId), stopNode);
    previous = { routeId: row.routeId, stopId: row.stop.id };
  }
  const citiesInScope = new Set([...stopCity.values()]);
  if (cityFilter) citiesInScope.add(cityFilter);
  const inScopeCity = (code: string) => req.scope === "trip" || citiesInScope.has(code);

  // Activities: everything in the cities in scope; planned relative to the scope.
  for (const a of activities) {
    if (!inScopeCity(a.cityCode)) continue;
    if (!nodes.has(nodeId.city(a.cityCode))) continue;
    const plannedHere = a.plannedIn.filter((p) => nodes.has(nodeId.stop(p.stopId)));
    const id = nodeId.activity(a.id);
    addNode({
      id,
      type: "activity",
      label: a.title,
      cityCode: a.cityCode,
      attrs: { when: a.when ?? null, costCad: a.costCad ?? null, url: a.url ?? null, mapsQuery: a.mapsQuery ?? null, tags: a.tags, commentCount: a.commentCount },
      style: {
        tag: primaryTag(a.tags),
        tags: a.tags,
        planned: plannedHere.length > 0,
        fixedDate: isFixedDate(a.when ?? null),
        votes: a.votes,
        routes: [...new Set(plannedHere.map((p) => p.routeId))],
      },
    });
    addEdge("IN", id, nodeId.city(a.cityCode));
    for (const p of plannedHere) addEdge("PLANS", nodeId.stop(p.stopId), id);
  }

  // Areas and hotels.
  for (const ar of areas) {
    if (!inScopeCity(ar.cityCode) || !nodes.has(nodeId.city(ar.cityCode))) continue;
    const id = nodeId.area(ar.id);
    addNode({
      id,
      type: "area",
      label: ar.name,
      ...(ar.lat != null && ar.lon != null ? { lat: ar.lat, lon: ar.lon } : {}),
      cityCode: ar.cityCode,
      attrs: { vibes: ar.vibes, note: ar.note ?? null, hotelCount: ar.hotelCount },
      style: { votes: ar.votes },
    });
    addEdge("IN", id, nodeId.city(ar.cityCode));
  }
  const statusRank: Record<string, number> = { booked: 3, chosen: 2, shortlist: 1 };
  for (const h of hotels) {
    if (!nodes.has(nodeId.area(h.areaId))) continue;
    const staysHere = h.stays.filter((s) => nodes.has(nodeId.stop(s.stopId)));
    const best = staysHere.reduce<string | undefined>(
      (b, s) => ((statusRank[s.status] ?? 0) > (statusRank[b ?? ""] ?? 0) ? s.status : b),
      undefined,
    );
    const id = nodeId.hotel(h.id);
    addNode({
      id,
      type: "hotel",
      label: h.name,
      ...(h.lat != null && h.lon != null ? { lat: h.lat, lon: h.lon } : {}),
      cityCode: h.cityCode,
      attrs: {
        areaId: h.areaId,
        priceCadPerNight: h.priceCadPerNight ?? null,
        priceBasis: h.priceBasis,
        sleeps: h.sleeps,
        url: h.url ?? null,
        rating: h.rating ?? null,
      },
      style: {
        votes: h.votes,
        planned: best === "chosen" || best === "booked",
        ...(best ? { status: best } : {}),
        routes: [...new Set(staysHere.map((s) => s.routeId))],
      },
    });
    addEdge("IN", id, nodeId.area(h.areaId));
    for (const s of staysHere) addEdge("STAYS_AT", nodeId.stop(s.stopId), id, { status: s.status });
  }

  // Hubs and legs.
  const addHub = (h: Hub, routeId?: string) => {
    const id = nodeId.hub(h);
    addNode({
      id,
      type: h.kind === "airport" ? "airport" : "station",
      label: h.code ? `${h.name} (${h.code})` : h.name,
      lat: h.lat,
      lon: h.lon,
      cityCode: h.cityCode,
      attrs: { hubId: h.id, code: h.code ?? null, stationKind: h.stationKind ?? null, cityName: h.cityName },
      style: { routes: routeId ? [routeId] : [] },
    });
    if (h.cityCode && nodes.has(nodeId.city(h.cityCode))) addEdge("SERVES", id, nodeId.city(h.cityCode));
    return id;
  };
  for (const h of cityHubs) addHub(h);
  for (const row of legRows) {
    if (!nodes.has(nodeId.stop(row.stopId))) {
      // City scope: keep legs that start or end in the city even when their stop is elsewhere.
      if (!cityFilter || (row.from.cityCode !== cityFilter && row.to.cityCode !== cityFilter)) continue;
    }
    const fromId = addHub(row.from, row.routeId);
    const toId = addHub(row.to, row.routeId);
    const id = nodeId.leg(row.leg.id);
    addNode({
      id,
      type: "leg",
      label: `${MODE_WORD[row.leg.mode] ?? row.leg.mode} ${row.from.code ?? row.from.name} → ${row.to.code ?? row.to.name}`,
      cityCode: row.cityCode,
      attrs: {
        routeId: row.routeId,
        stopId: row.stopId,
        seq: row.seq,
        from: fromId,
        to: toId,
        operator: row.leg.operator,
        number: row.leg.number,
        departAt: row.leg.departAt,
        arriveAt: row.leg.arriveAt,
        durationMin: row.leg.durationMin,
        priceCad: row.leg.priceCad,
      },
      style: { mode: row.leg.mode, status: row.leg.status, routes: [row.routeId] },
    });
    if (nodes.has(nodeId.stop(row.stopId))) addEdge("ARRIVES_VIA", nodeId.stop(row.stopId), id, { seq: row.seq });
    addEdge("FROM", id, fromId);
    addEdge("TO", id, toId);
  }

  // Optional type filter, then the size limits.
  let nodeList = [...nodes.values()];
  if (req.types?.length) {
    const keep = new Set<string>(req.types);
    nodeList = nodeList.filter((n) => keep.has(n.type));
  }
  const limited = truncate(nodeList, [...edges.values()], limits);
  const counts: Partial<Record<GraphNodeType, number>> = {};
  for (const n of limited.nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;

  return {
    nodes: limited.nodes,
    edges: limited.edges,
    meta: {
      tripId: req.tripId,
      scope: req.scope,
      routeId: routeFilter,
      city: cityFilter,
      truncated: limited.truncated,
      counts,
      generatedAt: new Date().toISOString(),
      routes: meta0.routes.map((r) => ({ id: r.id, name: r.name, isCurrent: r.isCurrent })),
      tripStart: meta0.trip.startDate,
    },
  };
}

/** A content hash, so an unchanged graph costs a 304 instead of the whole body. */
export function graphEtag(graph: GraphJSON): string {
  const { generatedAt: _at, ...meta } = graph.meta;
  const hash = createHash("sha1").update(JSON.stringify({ nodes: graph.nodes, edges: graph.edges, meta })).digest("base64url");
  return `"g-${hash}"`;
}

/** One hop around a node, from the trip graph (G5). */
export function neighbourhood(graph: GraphJSON, id: string, limit: number): GraphJSON | null {
  const centre = graph.nodes.find((n) => n.id === id);
  if (!centre) return null;
  const touching = graph.edges.filter((e) => e.source === id || e.target === id).slice(0, limit);
  const ids = new Set([id, ...touching.map((e) => (e.source === id ? e.target : e.source))]);
  const nodes = graph.nodes.filter((n) => ids.has(n.id));
  const counts: Partial<Record<GraphNodeType, number>> = {};
  for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
  return {
    nodes,
    edges: touching,
    meta: { ...graph.meta, counts, truncated: graph.edges.filter((e) => e.source === id || e.target === id).length > limit },
  };
}
