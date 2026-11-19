"use client";

import type { GraphEdge, GraphJSON, GraphNode, GraphNodeType, GraphScope, LegStatus } from "@trippr/contracts";
import { GRAPH_NODE_TYPES } from "@trippr/contracts";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { api } from "./api";
import { useAuth } from "./auth";
import { ACTIVITY_TAGS, type ActivityTag } from "./graph-palette";

// --- URL state ----------------------------------------------------------------

export type GraphView = "2d" | "3d" | "list";
export type GraphLayout = "force" | "geo";

export interface GraphUrlState {
  view: GraphView;
  scope: GraphScope;
  route: string | null;
  city: string | null;
  focus: string | null;
  tags: ActivityTag[];
  types: GraphNodeType[];
  routes: string[];
  countries: string[];
  legStatus: LegStatus[];
  plannedOnly: boolean;
  layout: GraphLayout;
}

const list = (v: string | null) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const oneOf = <T extends string>(v: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/** All explorer state lives in the URL, so every view is a deep link. */
export function useGraphUrlState(): [GraphUrlState, (patch: Partial<GraphUrlState>) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const state = useMemo<GraphUrlState>(
    () => ({
      view: oneOf(params.get("view"), ["2d", "3d", "list"] as const, "2d"),
      scope: oneOf(params.get("scope"), ["trip", "route", "city"] as const, params.get("route") ? "route" : "trip"),
      route: params.get("route"),
      city: params.get("city"),
      focus: params.get("focus"),
      tags: list(params.get("tags")).filter((t): t is ActivityTag => [...ACTIVITY_TAGS, "other"].includes(t)),
      types: list(params.get("types")).filter((t): t is GraphNodeType => (GRAPH_NODE_TYPES as readonly string[]).includes(t)),
      routes: list(params.get("routes")),
      countries: list(params.get("countries")),
      legStatus: list(params.get("status")).filter((s): s is LegStatus => ["idea", "held", "booked"].includes(s)),
      plannedOnly: params.get("planned") === "1",
      layout: oneOf(params.get("layout"), ["force", "geo"] as const, "force"),
    }),
    [params],
  );

  const update = useCallback(
    (patch: Partial<GraphUrlState>) => {
      const next = { ...state, ...patch };
      const q = new URLSearchParams();
      if (next.view !== "2d") q.set("view", next.view);
      if (next.scope !== "trip") q.set("scope", next.scope);
      if (next.route) q.set("route", next.route);
      if (next.city) q.set("city", next.city);
      if (next.focus) q.set("focus", next.focus);
      if (next.tags.length) q.set("tags", next.tags.join(","));
      if (next.types.length) q.set("types", next.types.join(","));
      if (next.routes.length) q.set("routes", next.routes.join(","));
      if (next.countries.length) q.set("countries", next.countries.join(","));
      if (next.legStatus.length) q.set("status", next.legStatus.join(","));
      if (next.plannedOnly) q.set("planned", "1");
      if (next.layout !== "force") q.set("layout", next.layout);
      if (params.get("fixture")) q.set("fixture", params.get("fixture")!);
      const s = q.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    [state, params, pathname, router],
  );

  return [state, update];
}

// --- data ---------------------------------------------------------------------

/**
 * Development-only fixture (built from seed/*.json by
 * scripts/build-graph-fixture.mjs). In production builds the condition is a
 * constant false, so the fixture is never bundled or used.
 */
export function useFixtureMode(): boolean {
  const params = useSearchParams();
  if (process.env.NODE_ENV === "production") return false;
  return process.env.NEXT_PUBLIC_GRAPH_FIXTURE === "1" || params.get("fixture") === "1";
}

async function loadFixture(): Promise<GraphJSON> {
  if (process.env.NODE_ENV === "production") throw new Error("Fixture is development-only");
  const mod = await import("@/dev/graph-fixture.json");
  return mod.default as unknown as GraphJSON;
}

export const graphKey = (tripId: string, scope: GraphScope, routeId: string | null, city: string | null) =>
  ["graph", tripId, scope, routeId, city] as const;

export function useGraph(tripId: string, scope: GraphScope, routeId: string | null, city: string | null) {
  const { status } = useAuth();
  const fixture = useFixtureMode();
  return useQuery({
    queryKey: graphKey(tripId, scope, routeId, city),
    queryFn: async () => {
      if (fixture) return scopeFixture(await loadFixture(), scope, routeId, city);
      const q = new URLSearchParams({ scope });
      if (scope === "route" && routeId) q.set("routeId", routeId);
      if (scope === "city" && city) q.set("city", city);
      return api<GraphJSON>(`/trips/${encodeURIComponent(tripId)}/graph?${q.toString()}`);
    },
    enabled: Boolean(tripId) && (fixture || status === "signedIn"),
    staleTime: 30_000,
  });
}

/** Neighbours of one node (G5), merged into the current graph by the caller. */
export async function fetchNeighbours(tripId: string, nodeId: string): Promise<GraphJSON | null> {
  try {
    return await api<GraphJSON>(
      `/trips/${encodeURIComponent(tripId)}/graph/nodes/${encodeURIComponent(nodeId)}/neighbours?limit=50`,
    );
  } catch {
    return null;
  }
}

export function mergeGraphs(a: GraphJSON, b: GraphJSON): GraphJSON {
  const nodes = new Map(a.nodes.map((n) => [n.id, n]));
  for (const n of b.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
  const edges = new Map(a.edges.map((e) => [e.id, e]));
  for (const e of b.edges) if (!edges.has(e.id) && nodes.has(e.source) && nodes.has(e.target)) edges.set(e.id, e);
  return { ...a, nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** The fixture is a trip-scope graph; narrow it client-side to mimic the API's scopes. */
function scopeFixture(g: GraphJSON, scope: GraphScope, routeId: string | null, city: string | null): GraphJSON {
  if (scope === "trip") return g;
  let keep: Set<string>;
  if (scope === "route" && routeId) {
    keep = new Set(g.nodes.filter((n) => n.style.routes?.includes(routeId)).map((n) => n.id));
    for (const e of g.edges) {
      if (keep.has(e.source) && ["AT", "IN", "SERVES", "FROM", "TO", "PLANS", "STAYS_AT"].includes(e.type)) keep.add(e.target);
    }
    for (const e of g.edges) if (e.type === "IN" && keep.has(e.source)) keep.add(e.target);
  } else if (scope === "city" && city) {
    keep = new Set(g.nodes.filter((n) => n.cityCode === city).map((n) => n.id));
    for (const e of g.edges) if (keep.has(e.source) && e.type === "IN") keep.add(e.target);
  } else return g;
  const nodes = g.nodes.filter((n) => keep.has(n.id));
  const edges = g.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  return { ...g, nodes, edges, meta: { ...g.meta, scope, routeId, city } };
}

// --- derived structure ----------------------------------------------------------

export interface GraphIndex {
  byId: Map<string, GraphNode>;
  out: Map<string, GraphEdge[]>;
  in: Map<string, GraphEdge[]>;
  /** Country iso for any node with a city. */
  countryOf: Map<string, string>;
}

export function indexGraph(g: GraphJSON): GraphIndex {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  for (const e of g.edges) {
    out.set(e.source, [...(out.get(e.source) ?? []), e]);
    inn.set(e.target, [...(inn.get(e.target) ?? []), e]);
  }
  const cityCountry = new Map<string, string>();
  for (const e of g.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (e.type === "IN" && s?.type === "city" && t?.type === "country") cityCountry.set(s.cityCode ?? s.id.slice(5), t.id);
  }
  const countryOf = new Map<string, string>();
  for (const n of g.nodes) {
    if (n.type === "country") countryOf.set(n.id, n.id);
    else if (n.cityCode && cityCountry.has(n.cityCode)) countryOf.set(n.id, cityCountry.get(n.cityCode)!);
  }
  return { byId, out, in: inn, countryOf };
}

export function neighbours(index: GraphIndex, id: string): Set<string> {
  const set = new Set<string>([id]);
  for (const e of index.out.get(id) ?? []) set.add(e.target);
  for (const e of index.in.get(id) ?? []) set.add(e.source);
  return set;
}

export interface GraphFilters {
  types: GraphNodeType[];
  tags: ActivityTag[];
  routes: string[];
  countries: string[];
  legStatus: LegStatus[];
  plannedOnly: boolean;
}

export const activeFilterCount = (f: GraphFilters) =>
  f.types.length + f.tags.length + f.routes.length + f.countries.length + f.legStatus.length + (f.plannedOnly ? 1 : 0);

/** Client-side filtering; edges are kept when both ends are. */
export function filterGraph(g: GraphJSON, index: GraphIndex, f: GraphFilters): GraphJSON {
  const typeOk = (n: GraphNode) => f.types.length === 0 || f.types.includes(n.type);
  const tagOk = (n: GraphNode) =>
    n.type !== "activity" || f.tags.length === 0 || f.tags.some((t) => (t === "other" ? !(n.style.tags ?? []).length : (n.style.tags ?? []).includes(t) || n.style.tag === t));
  const statusOk = (n: GraphNode) => n.type !== "leg" || f.legStatus.length === 0 || f.legStatus.includes((n.style.status ?? "idea") as LegStatus);
  const plannedOk = (n: GraphNode) => {
    if (!f.plannedOnly) return true;
    if (n.type === "activity") return Boolean(n.style.planned);
    if (n.type === "hotel") return n.style.status === "chosen" || n.style.status === "booked";
    return true;
  };
  const countryOk = (n: GraphNode) => {
    if (f.countries.length === 0) return true;
    const c = index.countryOf.get(n.id);
    return c ? f.countries.includes(c) : n.type === "trip" || n.type === "route" || n.type === "leg";
  };

  let keep = new Set(g.nodes.filter((n) => typeOk(n) && tagOk(n) && statusOk(n) && plannedOk(n) && countryOk(n)).map((n) => n.id));

  if (f.routes.length) {
    const inRoute = (n: GraphNode) => n.style.routes?.some((r) => f.routes.includes(r));
    const core = new Set([...keep].filter((id) => {
      const n = index.byId.get(id)!;
      return n.type === "trip" || inRoute(n);
    }));
    // Shared places (cities, countries, hubs) stay when a kept stop or leg reaches them.
    for (const id of [...core]) {
      for (const e of index.out.get(id) ?? []) if (keep.has(e.target)) core.add(e.target);
    }
    for (const id of [...core]) {
      const n = index.byId.get(id)!;
      if (n.type === "city") for (const e of index.out.get(id) ?? []) if (e.type === "IN" && keep.has(e.target)) core.add(e.target);
    }
    keep = core;
  }

  const nodes = g.nodes.filter((n) => keep.has(n.id));
  const edges = g.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  return { ...g, nodes, edges };
}

/** Reading order for keyboard navigation and the list: by type, then label. */
const TYPE_ORDER: GraphNodeType[] = ["trip", "route", "country", "city", "stop", "leg", "airport", "station", "area", "hotel", "activity"];
export function readingOrder(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort(
    (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.label.localeCompare(b.label),
  );
}

export interface JourneyStep {
  index: number;
  stop: GraphNode;
  leg: GraphNode | null;
  from: GraphNode | null;
  to: GraphNode | null;
}

/**
 * The journey for one route: its stops in order, each with the leg that
 * reaches it (first by seq) and that leg's hubs.
 */
export function journey(g: GraphJSON, index: GraphIndex, routeId: string | null): JourneyStep[] {
  const routes = g.meta.routes;
  const rid = routeId ?? routes.find((r) => r.isCurrent)?.id ?? routes[0]?.id;
  if (!rid) return [];
  const stops = g.nodes
    .filter((n) => n.type === "stop" && (n.style.routes?.includes(rid) || n.attrs.routeId === rid))
    .sort((a, b) => Number(a.attrs.order ?? 0) - Number(b.attrs.order ?? 0));
  return stops.map((stop, i) => {
    const via = (index.out.get(stop.id) ?? [])
      .filter((e) => e.type === "ARRIVES_VIA")
      .sort((a, b) => Number(a.attrs?.seq ?? 0) - Number(b.attrs?.seq ?? 0));
    const leg = via.length ? index.byId.get(via[0]!.target) ?? null : null;
    const end = (type: "FROM" | "TO") => {
      if (!leg) return null;
      const e = (index.out.get(leg.id) ?? []).find((x) => x.type === type);
      return e ? index.byId.get(e.target) ?? null : null;
    };
    return { index: i, stop, leg, from: end("FROM"), to: end("TO") };
  });
}

/** Where to draw a node: its own coordinates, or a small ring around its city. */
export function placeNode(n: GraphNode, index: GraphIndex, ringIndex: number, ringSize: number, radiusDeg = 0.18): [number, number] | null {
  if (typeof n.lat === "number" && typeof n.lon === "number") return [n.lon, n.lat];
  const city = n.cityCode ? index.byId.get(`city:${n.cityCode}`) : undefined;
  if (!city || typeof city.lat !== "number" || typeof city.lon !== "number") return null;
  const angle = (2 * Math.PI * ringIndex) / Math.max(ringSize, 1);
  return [city.lon + radiusDeg * Math.cos(angle), city.lat + radiusDeg * 0.8 * Math.sin(angle)];
}

export function describeNode(n: GraphNode): string {
  const parts: string[] = [n.label, n.type];
  if (n.type === "activity") {
    if (n.style.tags?.length) parts.push(n.style.tags.join(", "));
    parts.push(n.style.planned ? "planned" : "idea");
    if (n.style.fixedDate) parts.push("fixed date");
    if (n.style.votes) parts.push(`${n.style.votes} vote${Math.abs(n.style.votes) === 1 ? "" : "s"}`);
  }
  if (n.type === "leg") parts.push(String(n.style.mode ?? ""), String(n.style.status ?? "idea"));
  if (n.type === "hotel" && n.style.status) parts.push(n.style.status);
  return parts.filter(Boolean).join(", ");
}
