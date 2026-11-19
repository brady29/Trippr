"use client";

import type { GraphJSON, GraphNodeType } from "@trippr/contracts";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flaps } from "@/components/shell";
import { Button, ErrorNote } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import {
  activeFilterCount,
  describeNode,
  fetchNeighbours,
  filterGraph,
  indexGraph,
  journey,
  mergeGraphs,
  stopDates,
  useFixtureMode,
  useGraph,
  useGraphUrlState,
  type GraphFilters,
  type GraphView,
} from "@/lib/graph";
import { type ActivityTag } from "@/lib/graph-palette";
import { DetailsPanel } from "./DetailsPanel";
import { FilterBar } from "./FilterBar";
import type { CameraRequest } from "./GlobeView";
import { JourneyPlayer } from "./JourneyPlayer";
import { Legend } from "./Legend";
import { ListFallback } from "./ListFallback";
import { NodeSearch } from "./NodeSearch";

const Skeleton = ({ label }: { label: string }) => (
  <div className="grid h-full w-full place-items-center bg-board text-amber" role="status">
    <span className="animate-pulse text-xl">
      <Flaps text={label} />
    </span>
  </div>
);

const GraphCanvas2D = dynamic(() => import("./GraphCanvas2D"), { ssr: false, loading: () => <Skeleton label="Loading graph" /> });
const GlobeView = dynamic(() => import("./GlobeView"), { ssr: false, loading: () => <Skeleton label="Loading globe" /> });

function boundsOf(points: [number, number][]): CameraRequest["bounds"] | null {
  if (!points.length) return null;
  let [minX, minY, maxX, maxY] = [180, 90, -180, -90];
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [
    [minX - 2, minY - 2],
    [maxX + 2, maxY + 2],
  ];
}

export function GraphExplorer({ tripId }: { tripId: string }) {
  const [state, update] = useGraphUrlState();
  const { me } = useAuth();
  const fixture = useFixtureMode();
  const graphQuery = useGraph(tripId, state.scope, state.route, state.city);
  const [extra, setExtra] = useState<GraphJSON | null>(null);
  const [webglNotice, setWebglNotice] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [fitSignal, setFitSignal] = useState(0);
  const [camera, setCamera] = useState<CameraRequest | null>(null);
  const [journeyRoute, setJourneyRoute] = useState<string | null>(null);
  const [journeyIndex, setJourneyIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const listRef = useRef<HTMLTableElement>(null);

  useEffect(() => setExtra(null), [state.scope, state.route, state.city, tripId]);

  const full = useMemo(() => {
    if (!graphQuery.data) return null;
    return extra ? mergeGraphs(graphQuery.data, extra) : graphQuery.data;
  }, [graphQuery.data, extra]);
  const index = useMemo(() => (full ? indexGraph(full) : null), [full]);
  const dates = useMemo(() => (full ? stopDates(full) : undefined), [full]);
  const filters: GraphFilters = {
    types: state.types,
    tags: state.tags,
    routes: state.routes,
    countries: state.countries,
    legStatus: state.legStatus,
    plannedOnly: state.plannedOnly,
  };
  const filterKey = JSON.stringify(filters);
  const filtered = useMemo(
    () => (full && index ? filterGraph(full, index, JSON.parse(filterKey) as GraphFilters) : null),
    [full, index, filterKey],
  );
  const counts = useMemo(() => {
    const c: Partial<Record<GraphNodeType, number>> = {};
    for (const n of full?.nodes ?? []) c[n.type] = (c[n.type] ?? 0) + 1;
    return c;
  }, [full]);

  const selected = state.focus && index?.byId.has(state.focus) ? state.focus : null;
  const selectedNode = selected && index ? index.byId.get(selected)! : null;

  const select = useCallback(
    (id: string | null) => {
      update({ focus: id });
      const n = id && index ? index.byId.get(id) : null;
      setAnnounce(n ? `Selected ${describeNode(n)}` : "Selection cleared");
    },
    [update, index],
  );

  const expand = useCallback(
    async (id: string) => {
      if (fixture) return;
      const more = await fetchNeighbours(tripId, id);
      if (more) {
        setExtra((prev) => (prev ? mergeGraphs(prev, more) : more));
        setAnnounce(`Expanded ${index?.byId.get(id)?.label ?? "node"}: ${more.nodes.length} neighbours`);
      }
    },
    [tripId, fixture, index],
  );

  const steps = useMemo(() => (full && index ? journey(full, index, journeyRoute ?? state.route) : []), [full, index, journeyRoute, state.route]);
  const step = steps.length ? steps[Math.min(journeyIndex, steps.length - 1)]! : null;
  const journeyIds = useMemo(
    () => (playing || journeyIndex > 0) && step ? [step.stop.id, step.leg?.id, step.from?.id, step.to?.id].filter((x): x is string => Boolean(x)) : [],
    [playing, journeyIndex, step],
  );
  useEffect(() => {
    setJourneyIndex(0);
    setPlaying(false);
  }, [journeyRoute, state.scope, state.route]);

  // Camera presets for the globe.
  const presets = useMemo(() => {
    if (!full || !index) return [];
    const placed = (pred: (id: string) => boolean) =>
      full.nodes.filter((n) => pred(n.id) && typeof n.lon === "number" && typeof n.lat === "number").map((n) => [n.lon!, n.lat!] as [number, number]);
    const out: { key: string; label: string; bounds: CameraRequest["bounds"] }[] = [];
    const all = boundsOf(placed(() => true));
    if (all) out.push({ key: "trip", label: "Whole trip", bounds: all });
    for (const r of full.meta.routes) {
      const b = boundsOf(placed((id) => Boolean(index.byId.get(id)?.style.routes?.includes(r.id))));
      if (b) out.push({ key: `route:${r.id}`, label: r.name, bounds: b });
    }
    for (const c of full.nodes.filter((n) => n.type === "country")) {
      const b = boundsOf(placed((id) => index.countryOf.get(id) === c.id && index.byId.get(id)?.type !== "country"));
      if (b) out.push({ key: c.id, label: c.label, bounds: b });
    }
    return out;
  }, [full, index]);

  const view: GraphView = webglNotice && state.view !== "list" ? "list" : state.view;
  const scopeLabel =
    state.scope === "route"
      ? full?.meta.routes.find((r) => r.id === state.route)?.name ?? "Route"
      : state.scope === "city"
        ? (state.city && index?.byId.get(`city:${state.city}`)?.label) ?? state.city ?? "City"
        : "Trip";
  const nFilters = activeFilterCount(filters);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const viewButton = (v: GraphView, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={view === v}
      onClick={() => {
        if (v !== "list") setWebglNotice(null);
        update({ view: v });
      }}
      className={`min-h-10 rounded-md px-3 font-mono text-xs font-semibold tracking-wider ${view === v ? "bg-amber text-board" : "text-amber-soft hover:bg-board-3"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex min-h-[calc(100dvh-44px)] flex-col lg:h-[calc(100dvh-44px)]">
      <a
        href="#graph-list"
        onClick={(e) => {
          e.preventDefault();
          update({ view: "list" });
          setTimeout(() => listRef.current?.focus(), 50);
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-14 focus:z-50 focus:rounded-md focus:bg-amber focus:px-3 focus:py-2 focus:text-board"
      >
        Skip to list
      </a>
      <div className="bg-board pb-3 pt-3 text-amber-soft">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4">
          <h1 className="min-w-0 text-xl sm:text-2xl">
            <Flaps text={`Graph · ${scopeLabel}`} />
          </h1>
          <div role="radiogroup" aria-label="View" className="flex rounded-lg border border-board-3 p-0.5" data-testid="graph-view-toggle">
            {viewButton("2d", "2D")}
            {viewButton("3d", "3D")}
            {viewButton("list", "LIST")}
          </div>
          <label className="flex items-center gap-2 text-xs">
            <span className="sr-only">Scope</span>
            <select
              value={state.scope === "route" ? `route:${state.route ?? ""}` : state.scope === "city" ? `city:${state.city ?? ""}` : "trip"}
              onChange={(e) => {
                const [scope, value] = e.target.value.split(":") as [string, string | undefined];
                if (scope === "route") update({ scope: "route", route: value ?? null, city: null, focus: null });
                else if (scope === "city") update({ scope: "city", city: value ?? null, route: null, focus: null });
                else update({ scope: "trip", route: null, city: null, focus: null });
              }}
              className="h-10 rounded-lg border border-board-3 bg-board-2 px-2 text-amber-soft"
              aria-label="Scope"
            >
              <option value="trip">Whole trip</option>
              {(full?.meta.routes ?? []).map((r) => (
                <option key={r.id} value={`route:${r.id}`}>
                  Route: {r.name}
                </option>
              ))}
              {state.scope === "city" && state.city ? <option value={`city:${state.city}`}>City: {scopeLabel}</option> : null}
            </select>
          </label>
          {view === "2d" ? (
            <div role="radiogroup" aria-label="Layout" className="flex rounded-lg border border-board-3 p-0.5 text-xs">
              {(["force", "geo"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={state.layout === l}
                  onClick={() => update({ layout: l })}
                  className={`min-h-10 rounded-md px-3 ${state.layout === l ? "bg-board-3 text-amber" : "text-amber-soft/80 hover:text-amber"}`}
                >
                  {l === "force" ? "Force" : "Geography"}
                </button>
              ))}
            </div>
          ) : null}
          {view === "3d" && presets.length ? (
            <select
              aria-label="Camera"
              defaultValue=""
              onChange={(e) => {
                const p = presets.find((x) => x.key === e.target.value);
                if (p) setCamera({ key: `${p.key}:${Date.now()}`, bounds: p.bounds });
              }}
              className="h-10 rounded-lg border border-board-3 bg-board-2 px-2 text-xs text-amber-soft"
            >
              <option value="" disabled>
                Camera…
              </option>
              {presets.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          ) : null}
          <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
            {full ? <NodeSearch nodes={full.nodes} onPick={select} /> : null}
            {view === "2d" ? (
              <Button size="sm" className="h-10" onClick={() => setFitSignal((s) => s + 1)}>
                Fit
              </Button>
            ) : null}
            <Button size="sm" className="h-10 lg:hidden" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
              Filters{nFilters ? ` (${nFilters})` : ""}
            </Button>
          </div>
        </div>
      </div>

      {graphQuery.isPending ? (
        <div className="h-[60dvh]">
          <Skeleton label="Loading graph" />
        </div>
      ) : graphQuery.error ? (
        <div className="mx-auto w-full max-w-3xl space-y-3 p-4">
          <ErrorNote error={graphQuery.error} />
          <Button onClick={() => void graphQuery.refetch()}>Try again</Button>
        </div>
      ) : full && filtered && index ? (
        <>
          <div className={`border-b border-line bg-card px-4 py-3 ${showFilters ? "block" : "hidden lg:block"}`}>
            <div className="mx-auto flex max-w-[1400px] flex-col gap-3">
              <Legend
                counts={counts}
                types={state.types}
                tags={state.tags}
                onToggleType={(t) => update({ types: toggle(state.types, t) })}
                onToggleTag={(t: ActivityTag) => update({ tags: toggle(state.tags, t) })}
              />
              <FilterBar
                graph={full}
                state={state}
                update={update}
                activeCount={nFilters}
                onClear={() => update({ types: [], tags: [], routes: [], countries: [], legStatus: [], plannedOnly: false })}
              />
            </div>
            {full.meta.truncated ? (
              <p className="mx-auto mt-2 max-w-[1400px] text-xs text-warn">This graph was trimmed to stay fast. Pick a route or a city to see everything.</p>
            ) : null}
            {(counts.hotel ?? 0) === 0 ? (
              <p className="mx-auto mt-2 max-w-[1400px] text-xs text-ink-faint">No hotels yet. Shortlist a hotel in an area you like.</p>
            ) : null}
          </div>

          <div className="relative flex min-h-0 flex-1">
            <div className="relative h-[70dvh] min-w-0 flex-1 lg:h-auto lg:min-h-[360px]">
              {filtered.nodes.length === 0 ? (
                <div className="grid h-full place-items-center p-6 text-center text-sm text-ink-soft">
                  {full.nodes.length === 0 ? "Nothing in this graph yet. Add stops and activities in the route editor." : "No nodes match these filters."}
                </div>
              ) : view === "list" ? (
                <ListFallback ref={listRef} graph={filtered} index={index} selected={selected} onSelect={select} notice={webglNotice} />
              ) : view === "3d" ? (
                <div className="absolute inset-0">
                  <GlobeView
                    graph={filtered}
                    index={index}
                    selected={selected}
                    step={journeyIds.length ? step : null}
                    camera={camera}
                    onSelect={select}
                    onUnavailable={(reason) => setWebglNotice(`${reason} Showing the list instead.`)}
                  />
                </div>
              ) : (
                <div className="absolute inset-0">
                  <GraphCanvas2D
                    graph={filtered}
                    index={index}
                    layout={state.layout}
                    scopeKey={`${tripId}:${state.scope}:${state.route ?? ""}:${state.city ?? ""}`}
                    selected={selected}
                    journeyIds={journeyIds}
                    fitSignal={fitSignal}
                    onSelect={select}
                    onCursor={(id) => {
                      const n = id ? index.byId.get(id) : null;
                      if (n) setAnnounce(describeNode(n));
                    }}
                    onExpand={(id) => void expand(id)}
                  />
                </div>
              )}
            </div>
            {selectedNode ? (
              <aside
                className="fixed inset-x-0 bottom-0 z-40 max-h-[60dvh] overflow-hidden rounded-t-2xl border-t border-line bg-card shadow-2xl lg:static lg:z-auto lg:max-h-none lg:w-[360px] lg:rounded-none lg:border-l lg:border-t-0 lg:shadow-none"
                data-testid="graph-details"
              >
                <DetailsPanel
                  node={selectedNode}
                  index={index}
                  tripId={tripId}
                  canVote={!fixture && !me?.isDemo}
                  onSelect={select}
                  onClose={() => select(null)}
                  onExpand={(id) => void expand(id)}
                  onCityScope={(code) => update({ scope: "city", city: code, route: null, focus: `city:${code}` })}
                  dates={dates}
                />
              </aside>
            ) : null}
          </div>

          {view !== "list" ? (
            <JourneyPlayer
              steps={steps}
              index={journeyIndex}
              playing={playing}
              routes={full.meta.routes}
              routeId={journeyRoute ?? state.route ?? full.meta.routes.find((r) => r.isCurrent)?.id ?? null}
              onRoute={setJourneyRoute}
              onIndex={setJourneyIndex}
              onPlaying={setPlaying}
            />
          ) : null}
        </>
      ) : null}
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
    </div>
  );
}
