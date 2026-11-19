"use client";

/**
 * 2D knowledge-graph canvas (Cytoscape.js + fcose). Loaded with
 * next/dynamic (ssr: false) so nothing here reaches other routes.
 *
 * Layout runs on the main thread with animation off; positions are cached
 * per scope in sessionStorage so a second visit renders without a layout
 * pass. (fcose needs a Cytoscape instance, so moving it into a Web Worker
 * means a headless instance there; left for later if 500+ node graphs
 * prove slow on phones.)
 */
import type { GraphJSON, GraphNode } from "@trippr/contracts";
import type { Core, ElementDefinition, StylesheetJson } from "cytoscape";
import { useEffect, useMemo, useRef, useState } from "react";
import { readingOrder, type GraphIndex, type GraphLayout } from "@/lib/graph";
import {
  activityRadius,
  AIRPORT_POLYGON,
  FIXED_DATE,
  ICON_PATHS,
  iconDataUri,
  LABEL,
  lineKind,
  MODE_COLOR,
  NODE_SHAPE,
  nodeColor,
  primaryTag,
  STATUS_BADGE,
  STATUS_OPACITY,
} from "@/lib/graph-palette";

let fcoseRegistered = false;
const PAPER = "#F4EFE4";
const CARD = "#FFFDF8";

const SIZE: Record<string, [number, number]> = {
  trip: [44, 44],
  route: [72, 26],
  country: [46, 46],
  city: [36, 36],
  stop: [18, 18],
  area: [40, 40],
  hotel: [26, 26],
  station: [26, 24],
  airport: [26, 24],
  leg: [58, 18],
};

function toElement(n: GraphNode): ElementDefinition {
  const color = nodeColor(n.type, "paper", n.style);
  const data: Record<string, unknown> = {
    id: n.id,
    type: n.type,
    label: n.label,
    shape: NODE_SHAPE[n.type],
    color,
    w: SIZE[n.type]?.[0] ?? 24,
    h: SIZE[n.type]?.[1] ?? 24,
    borderColor: CARD,
    borderWidth: 1.5,
    borderStyle: "solid",
    bgOpacity: 1,
    opacity: 1,
    ring: 0,
    ringColor: FIXED_DATE.paper,
    fontSize: n.type === "city" || n.type === "route" || n.type === "country" ? 12 : 10,
  };
  if (n.type === "airport") data.shapePoints = AIRPORT_POLYGON;
  if (n.type === "activity") {
    const tag = primaryTag(n.style.tags, n.style.tag);
    const d = activityRadius(n.style.votes) * 2 * 0.8;
    data.w = d;
    data.h = d;
    if (n.style.planned) {
      data.icon = iconDataUri(ICON_PATHS[tag], "#FFFFFF");
    } else {
      // Idea: light fill with a 3px coloured ring.
      data.color = CARD;
      data.borderColor = color;
      data.borderWidth = 3;
      data.icon = iconDataUri(ICON_PATHS[tag], color);
    }
    if (n.style.fixedDate) data.ring = 3;
    if ((n.style.votes ?? 0) < 0) data.label = `${n.label} (−)`;
  }
  if (n.type === "area") {
    data.bgOpacity = 0.2;
    data.borderColor = color;
    data.borderStyle = "dashed";
    data.borderWidth = 2;
  }
  if (n.type === "hotel") {
    const chosen = n.style.status === "chosen" || n.style.status === "booked";
    data.icon = iconDataUri(ICON_PATHS.hotel, chosen ? "#FFFFFF" : color);
    if (!chosen) {
      data.color = CARD;
      data.borderColor = color;
      data.borderWidth = 2.5;
    }
    if (n.style.status === "booked") data.label = `${n.label} ✓`;
  }
  if (n.type === "airport") data.icon = iconDataUri(ICON_PATHS.airport, "#FFFFFF");
  if (n.type === "leg") {
    const status = n.style.status ?? "idea";
    data.opacity = STATUS_OPACITY[status] ?? 0.4;
    data.label = `${n.label} ${STATUS_BADGE[status] ?? ""}`.trim();
    data.borderStyle = lineKind(n.style.mode) === "arc" ? "dashed" : lineKind(n.style.mode) === "dotted" ? "dotted" : "solid";
    data.borderColor = color;
    data.color = CARD;
    data.borderWidth = 2;
  }
  return { group: "nodes", data };
}

function edgeElement(e: GraphJSON["edges"][number], byId: Map<string, GraphNode>): ElementDefinition {
  const data: Record<string, unknown> = { id: e.id, source: e.source, target: e.target, type: e.type, color: "#B9B09C", lineStyle: "solid", opacity: 0.75, width: 1.2 };
  if (e.type === "FROM" || e.type === "TO") {
    const leg = byId.get(e.source);
    const mode = String(leg?.style.mode ?? "train");
    data.color = (MODE_COLOR[mode] ?? MODE_COLOR.train!).paper;
    data.lineStyle = lineKind(mode) === "arc" ? "dashed" : lineKind(mode) === "dotted" ? "dotted" : "solid";
    data.opacity = STATUS_OPACITY[String(leg?.style.status ?? "idea")] ?? 0.4;
    data.width = 2.5;
  }
  if (e.type === "NEXT") {
    data.color = "#59626E";
    data.width = 2;
  }
  return { group: "edges", data };
}

const STYLE: StylesheetJson = [
  {
    selector: "node",
    style: {
      shape: "data(shape)" as never,
      "background-color": "data(color)",
      "background-opacity": "data(bgOpacity)" as never,
      width: "data(w)",
      height: "data(h)",
      label: "data(label)",
      "font-family": "IBM Plex Sans, system-ui, sans-serif",
      "font-size": "data(fontSize)" as never,
      color: LABEL.paper,
      "text-valign": "bottom",
      "text-margin-y": 4,
      "text-outline-color": PAPER,
      "text-outline-width": 2,
      "text-max-width": "120px",
      "text-wrap": "ellipsis",
      "min-zoomed-font-size": 7,
      "border-color": "data(borderColor)",
      "border-width": "data(borderWidth)" as never,
      "border-style": "data(borderStyle)" as never,
      opacity: "data(opacity)" as never,
    },
  },
  { selector: "node[shapePoints]", style: { "shape-polygon-points": "data(shapePoints)" as never } },
  { selector: "node[icon]", style: { "background-image": "data(icon)", "background-width": "62%", "background-height": "62%", "background-clip": "none" } },
  { selector: "node[ring > 0]", style: { "outline-width": "data(ring)" as never, "outline-color": "data(ringColor)" as never, "outline-offset": 2 } as never },
  {
    selector: "edge",
    style: {
      width: "data(width)" as never,
      "line-color": "data(color)",
      "line-style": "data(lineStyle)" as never,
      opacity: "data(opacity)" as never,
      "curve-style": "bezier",
      "target-arrow-shape": "triangle",
      "target-arrow-color": "data(color)",
      "arrow-scale": 0.55,
    },
  },
  { selector: "edge[type = 'IN'], edge[type = 'SERVES'], edge[type = 'AT']", style: { "target-arrow-shape": "none", opacity: 0.45 } },
  { selector: ".dim", style: { opacity: 0.25 } },
  { selector: "node.hl", style: { "underlay-color": "#FFC23D", "underlay-opacity": 0.45, "underlay-padding": 7, "z-index": 20 } as never },
  { selector: "edge.hl", style: { opacity: 1, width: 3, "z-index": 20 } },
  { selector: "node.journey", style: { "underlay-color": "#3867C8", "underlay-opacity": 0.35, "underlay-padding": 6 } as never },
  { selector: "edge.journey", style: { opacity: 1, width: 4 } },
  { selector: "node.cursor", style: { "overlay-color": "#3867C8", "overlay-opacity": 0.18, "overlay-padding": 8 } as never },
];

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function readPositions(key: string): Record<string, { x: number; y: number }> {
  try {
    return JSON.parse(window.sessionStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
}
function writePositions(key: string, value: Record<string, { x: number; y: number }>) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/** Web Mercator placement for the "geo" layout. */
function geoPosition(n: GraphNode, index: GraphIndex, ring: Map<string, number>, ringSize: Map<string, number>) {
  const K = 60;
  let lon = n.lon;
  let lat = n.lat;
  if (typeof lon !== "number" || typeof lat !== "number") {
    const city = n.cityCode ? index.byId.get(`city:${n.cityCode}`) : undefined;
    if (!city || typeof city.lon !== "number" || typeof city.lat !== "number") return null;
    const key = city.id;
    const i = ring.get(key) ?? 0;
    ring.set(key, i + 1);
    const total = ringSize.get(key) ?? 1;
    const angle = (2 * Math.PI * i) / total;
    lon = city.lon + 0.6 * Math.cos(angle);
    lat = city.lat + 0.5 * Math.sin(angle);
  }
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return { x: lon * K, y: (-y * 180) / Math.PI * K };
}

export interface Canvas2DProps {
  graph: GraphJSON;
  index: GraphIndex;
  layout: GraphLayout;
  scopeKey: string;
  selected: string | null;
  journeyIds: string[];
  fitSignal: number;
  onSelect(id: string | null): void;
  onCursor(id: string | null): void;
  onExpand(id: string): void;
}

export default function GraphCanvas2D(props: Canvas2DProps) {
  const { graph, index, layout, scopeKey, selected, journeyIds, fitSignal } = props;
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [ready, setReady] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const handlers = useRef(props);
  handlers.current = props;

  const ordered = useMemo(() => readingOrder(graph.nodes), [graph.nodes]);

  // Create the Cytoscape instance once.
  useEffect(() => {
    let cy: Core | null = null;
    let cancelled = false;
    (async () => {
      const [{ default: cytoscape }, { default: fcose }] = await Promise.all([import("cytoscape"), import("cytoscape-fcose")]);
      if (cancelled || !container.current) return;
      if (!fcoseRegistered) {
        cytoscape.use(fcose);
        fcoseRegistered = true;
      }
      cy = cytoscape({
        container: container.current,
        style: STYLE,
        elements: [],
        minZoom: 0.08,
        maxZoom: 4,
        boxSelectionEnabled: false,
        selectionType: "single",
      });
      cy.on("tap", "node", (e) => handlers.current.onSelect(e.target.id()));
      cy.on("tap", (e) => {
        if (e.target === cy) handlers.current.onSelect(null);
      });
      cy.on("dbltap", "node", (e) => handlers.current.onExpand(e.target.id()));
      cyRef.current = cy;
      setReady(true);
    })();
    // Keep Cytoscape's idea of its size in step with the container.
    const ro = new ResizeObserver(() => {
      if (!cy) return;
      cy.resize();
    });
    if (container.current) ro.observe(container.current);
    return () => {
      cancelled = true;
      ro.disconnect();
      cy?.destroy();
      cyRef.current = null;
    };
  }, []);

  // Load elements and lay them out whenever the filtered graph or layout changes.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !ready) return;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const elements = [...graph.nodes.map(toElement), ...graph.edges.map((e) => edgeElement(e, byId))];
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    const posKey = `trippr.graph.pos:${scopeKey}:${layout}`;
    if (layout === "geo") {
      const ring = new Map<string, number>();
      const ringSize = new Map<string, number>();
      for (const n of graph.nodes) {
        if (typeof n.lat !== "number" && n.cityCode) ringSize.set(`city:${n.cityCode}`, (ringSize.get(`city:${n.cityCode}`) ?? 0) + 1);
      }
      const positions: Record<string, { x: number; y: number }> = {};
      for (const n of graph.nodes) {
        const p = geoPosition(n, index, ring, ringSize);
        if (p) positions[n.id] = p;
      }
      // Nodes with no place of their own (trip, routes, countries, legs) sit at
      // the centre of their placed neighbours, nudged apart.
      const adjacent = new Map<string, string[]>();
      for (const e of graph.edges) {
        adjacent.set(e.source, [...(adjacent.get(e.source) ?? []), e.target]);
        adjacent.set(e.target, [...(adjacent.get(e.target) ?? []), e.source]);
      }
      for (let pass = 0; pass < 4; pass++) {
        let nudge = 0;
        for (const n of graph.nodes) {
          if (positions[n.id]) continue;
          const near = (adjacent.get(n.id) ?? []).map((id) => positions[id]).filter((p): p is { x: number; y: number } => Boolean(p));
          if (!near.length) continue;
          const cx = near.reduce((s, p) => s + p.x, 0) / near.length;
          const cy = near.reduce((s, p) => s + p.y, 0) / near.length;
          const angle = (nudge++ * 2.4) % (2 * Math.PI);
          const r = n.type === "leg" ? 0 : 40;
          positions[n.id] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
        }
      }
      let spare = 0;
      for (const n of graph.nodes) positions[n.id] ??= { x: (spare += 80), y: 0 };
      cy.layout({ name: "preset", positions: (node: { id(): string }) => positions[node.id()]!, animate: false, fit: true, padding: 40 } as never).run();
      return;
    }
    const cached = readPositions(posKey);
    const missing = graph.nodes.filter((n) => !cached[n.id]);
    if (missing.length === 0) {
      cy.layout({ name: "preset", positions: (node: { id(): string }) => cached[node.id()]!, animate: false, fit: true, padding: 40 } as never).run();
      return;
    }
    const known = Object.keys(cached).length > 0;
    const run = cy.layout({
      name: "fcose",
      quality: graph.nodes.length > 600 ? "draft" : "default",
      randomize: !known,
      animate: false,
      fit: true,
      padding: 40,
      nodeRepulsion: () => 6500,
      idealEdgeLength: () => 70,
      nodeSeparation: 60,
      ...(known
        ? { fixedNodeConstraint: graph.nodes.filter((n) => cached[n.id]).slice(0, 200).map((n) => ({ nodeId: n.id, position: cached[n.id]! })) }
        : {}),
    } as never);
    run.one("layoutstop", () => {
      cy.resize();
      cy.fit(undefined, 40);
      const out: Record<string, { x: number; y: number }> = {};
      cy.nodes().forEach((node) => {
        const p = node.position();
        out[node.id()] = { x: Math.round(p.x), y: Math.round(p.y) };
      });
      writePositions(posKey, out);
    });
    run.run();
  }, [graph, index, layout, scopeKey, ready]);

  // Selection: highlight the one-hop neighbourhood, dim the rest.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !ready) return;
    cy.batch(() => {
      cy.elements().removeClass("dim hl");
      if (!selected) return;
      const node = cy.getElementById(selected);
      if (node.empty()) return;
      const hood = node.closedNeighborhood();
      cy.elements().not(hood).addClass("dim");
      hood.addClass("hl");
    });
    if (selected) {
      const node = cy.getElementById(selected);
      if (node.nonempty()) {
        if (reducedMotion()) cy.center(node);
        else cy.animate({ center: { eles: node } }, { duration: 300 });
      }
    }
  }, [selected, ready, graph]);

  // Journey playback highlight.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !ready) return;
    cy.batch(() => {
      cy.elements().removeClass("journey");
      for (const id of journeyIds) {
        const el = cy.getElementById(id);
        el.addClass("journey");
        el.connectedEdges().filter((e) => journeyIds.includes(e.source().id()) && journeyIds.includes(e.target().id())).addClass("journey");
      }
    });
    const last = journeyIds.length ? cy.getElementById(journeyIds[journeyIds.length - 1]!) : null;
    if (last && last.nonempty()) {
      if (reducedMotion()) cy.center(last);
      else cy.animate({ center: { eles: last } }, { duration: 400 });
    }
  }, [journeyIds, ready, graph]);

  useEffect(() => {
    const cy = cyRef.current;
    if (cy && ready && fitSignal > 0) cy.fit(undefined, 40);
  }, [fitSignal, ready]);

  // Keyboard cursor in reading order.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !ready) return;
    cy.nodes().removeClass("cursor");
    if (cursor) cy.getElementById(cursor).addClass("cursor");
  }, [cursor, ready, graph]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cy = cyRef.current;
    if (!cy || ordered.length === 0) return;
    const at = cursor ? ordered.findIndex((n) => n.id === cursor) : -1;
    const move = (delta: number) => {
      const next = ordered[(at + delta + ordered.length) % ordered.length]!;
      setCursor(next.id);
      handlers.current.onCursor(next.id);
      const el = cy.getElementById(next.id);
      if (el.nonempty()) cy.center(el);
    };
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Enter":
        if (cursor) handlers.current.onSelect(cursor);
        break;
      case "e":
      case "E":
        if (cursor ?? selected) handlers.current.onExpand((cursor ?? selected)!);
        break;
      case "f":
      case "F":
        cy.fit(undefined, 40);
        break;
      case "Escape":
        setCursor(null);
        handlers.current.onCursor(null);
        handlers.current.onSelect(null);
        break;
    }
  };

  return (
    <div
      ref={container}
      tabIndex={0}
      role="application"
      aria-roledescription="graph"
      aria-label={`Trip graph with ${graph.nodes.length} nodes. Arrow keys move between nodes, Enter opens details, E expands, F fits, Escape clears.`}
      onKeyDown={onKeyDown}
      data-testid="graph-canvas-2d"
      className="h-full w-full bg-paper outline-none focus-visible:ring-2 focus-visible:ring-sky"
    />
  );
}
