"use client";

import { hasRole, type GraphNode, type StopView } from "@trippr/contracts";
import { buildItinerary, dayDate, shortDate, type Itinerary, type When } from "@trippr/rules";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ShapeGlyph } from "@/components/map/glyph";
import type { Bounds } from "@/components/map/trip-map";
import { PlaceEditor } from "@/components/place-editor";
import { PlaceLinks } from "@/components/place-links";
import { StayCellCard, StayLegend, StayToggle, useStayHeat } from "@/components/stay-heat";
import { BoardHeader, BoardStat, RequireAuth, TopBar } from "@/components/shell";
import { TripNav } from "@/components/trip-nav";
import { Button, ErrorNote, Input, Select, Spinner, Tag } from "@/components/ui";
import { useGraph } from "@/lib/graph";
import { ACTIVITY_TAGS, NODE_FILL, TAG_COLOR, TAG_LABEL, type ActivityTag } from "@/lib/graph-palette";
import {
  activityFromNode,
  buildMapItems,
  dayOptions,
  dayScope,
  describeItem,
  inBounds,
  itemKind,
  MAP_LAYER_LABEL,
  MAP_LAYERS,
  parseFocus,
  resolveFocus,
  routeSegments,
  type MapItem,
  type MapLayer,
  type MapShape,
} from "@/lib/map-features";
import { useRoute, useTrip } from "@/lib/queries";
import type { StayFeatureProps } from "@/lib/stay-cells";

const TripMap = dynamic(() => import("@/components/map/trip-map"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-paper-2" />,
});

const NO_LINES: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** The legend: each toggle shows its marker. */
const LAYER_GLYPH: Record<MapLayer, { shape: MapShape; color: string }[]> = {
  route: [{ shape: "stop", color: "" }],
  planned: [{ shape: "circle", color: TAG_COLOR.culture }],
  ideas: [{ shape: "ring", color: TAG_COLOR.culture }],
  events: [{ shape: "diamond", color: TAG_COLOR.sport }],
  hotels: [
    { shape: "square", color: NODE_FILL.hotel.paper },
    { shape: "square-outline", color: NODE_FILL.hotel.paper },
  ],
  hubs: [
    { shape: "triangle", color: NODE_FILL.station.paper },
    { shape: "plane", color: NODE_FILL.airport.paper },
  ],
  areas: [{ shape: "area", color: NODE_FILL.area.paper }],
};

function whenText(when: When | null | undefined): string | null {
  if (!when) return null;
  if ("on" in when) return `On ${shortDate(when.on)}`;
  if ("from" in when) return `${shortDate(when.from)} to ${shortDate(when.to)}`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `Usually ${when.weekdays.map((d) => names[d] ?? d).join(", ")}`;
}

/** Where the activity sits in the itinerary, if it's planned on a day. */
function plannedDay(itinerary: Itinerary | null, activityId: string): string | null {
  const day = itinerary?.days.find((d) => d.items.some((i) => i.activityId === activityId));
  return day ? `Day ${day.index}, ${dayDate(day.date)}` : null;
}

function DetailCard({
  item,
  node,
  stop,
  itinerary,
  routeId,
  canEdit,
  onClose,
}: {
  item: MapItem;
  node: GraphNode | undefined;
  stop: StopView | undefined;
  itinerary: Itinerary | null;
  routeId: string;
  canEdit: boolean;
  onClose(): void;
}) {
  const [moving, setMoving] = useState(false);
  const activity = node?.type === "activity" ? activityFromNode(node, item.cityName) : null;
  const facts: string[] = [];
  if (activity) {
    const w = whenText(activity.when);
    if (w) facts.push(w);
    const d = plannedDay(itinerary, activity.id);
    if (d) facts.push(`Planned for ${d}`);
    if (activity.address) facts.push(activity.address);
  }
  if (node?.type === "hotel") {
    const price = node.attrs.priceCadPerNight;
    if (typeof price === "number") facts.push(`$${price} CAD a night${node.attrs.priceBasis === "person" ? " per person" : ""}`);
    if (typeof node.attrs.rating === "number") facts.push(`Rated ${node.attrs.rating}/10`);
  }
  if (node?.type === "station" && node.attrs.stationKind) facts.push(String(node.attrs.stationKind).toUpperCase());
  if (node?.type === "area") {
    const vibes = Array.isArray(node.attrs.vibes) ? (node.attrs.vibes as string[]) : [];
    if (vibes.length) facts.push(vibes.join(", "));
    if (node.attrs.note) facts.push(String(node.attrs.note));
  }
  if (stop) facts.push(`${stop.nights} night${stop.nights === 1 ? "" : "s"}, ${dayDate(stop.arrive)} to ${dayDate(stop.depart)}`);
  const hotelUrl = node?.type === "hotel" && typeof node.attrs.url === "string" ? node.attrs.url : null;

  return (
    <section className="rounded-2xl border border-line bg-card p-3" data-testid="map-card" aria-label={`Details: ${item.label}`}>
      <div className="flex items-start gap-2">
        <ShapeGlyph shape={item.shape} color={item.color} n={item.n} className="mt-0.5 h-5 w-5" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold leading-snug">{item.label}</h2>
          <div className="text-xs text-ink-soft">
            {itemKind(item)}
            {item.cityName && item.layer !== "route" ? ` · ${item.cityName}` : ""}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close details">
          Close
        </Button>
      </div>
      {item.tags.length || item.votes ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {item.tags.map((t) => (
            <Tag key={t}>{TAG_LABEL[t as ActivityTag] ?? t}</Tag>
          ))}
          {item.votes ? (
            <span className="text-xs text-ink-soft">
              {item.votes} vote{Math.abs(item.votes) === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      ) : null}
      {facts.length ? (
        <ul className="mt-2 space-y-0.5 text-sm text-ink-soft">
          {facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}
      {activity ? <PlaceLinks activity={activity} className="mt-2 text-sm" /> : null}
      {hotelUrl ? (
        <a href={hotelUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-sky hover:underline">
          Hotel website
        </a>
      ) : null}
      {stop ? (
        <Link href={`/routes/${routeId}`} className="mt-2 inline-block text-sm text-sky hover:underline">
          Open in the route editor
        </Link>
      ) : null}
      {activity && canEdit ? (
        moving ? (
          <PlaceEditor activity={activity} onClose={() => setMoving(false)} />
        ) : (
          <div className="mt-2">
            <Button size="sm" onClick={() => setMoving(true)} data-testid="move-pin">
              Move pin
            </Button>
          </div>
        )
      ) : null}
    </section>
  );
}

function MapTab({ tripId }: { tripId: string }) {
  const trip = useTrip(tripId);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const routes = trip.data?.routes ?? [];
  const routeId = params.get("route") ?? routes.find((r) => r.isCurrent)?.id ?? routes[0]?.id ?? "";
  const day = params.get("day");
  const focusRaw = params.get("focus");
  const route = useRoute(routeId);
  const graph = useGraph(tripId, "route", routeId || null, null);
  const canEdit = hasRole(trip.data?.role, "editor");
  const isOwner = trip.data?.role === "owner";

  const [layers, setLayers] = useState<Set<MapLayer>>(() => new Set(MAP_LAYERS));
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [fly, setFly] = useState<{ key: number; id: string } | null>(null);
  const [view, setView] = useState<Bounds | null>(null);
  const [inViewOnly, setInViewOnly] = useState(true);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [stayOn, setStayOn] = useState(false);
  const [stayCell, setStayCell] = useState<StayFeatureProps | null>(null);
  const card = useRef<HTMLDivElement>(null);

  const setParams = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    const s = q.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  const stops = useMemo(() => route.data?.stops ?? [], [route.data]);
  const itinerary = useMemo(() => (route.data ? buildItinerary(route.data.stops) : null), [route.data]);
  const days = useMemo(() => dayOptions(itinerary), [itinerary]);
  const scopeDay = useMemo(() => (itinerary && day ? dayScope(itinerary, day, graph.data) : null), [itinerary, day, graph.data]);
  const focusIds = useMemo(() => parseFocus(focusRaw), [focusRaw]);
  const focus = useMemo(() => (focusIds.length ? resolveFocus(focusIds, graph.data, stops) : null), [focusIds, graph.data, stops]);
  const { items, unplaced, truncated } = useMemo(
    () => buildMapItems(graph.data, stops, { layers, search, day: scopeDay, focus }),
    [graph.data, stops, layers, search, scopeDay, focus],
  );
  const segments = useMemo(
    () => (layers.has("route") ? routeSegments(stops, { only: scopeDay?.travelStopIds ?? null, highlight: focus?.segmentStopIds ?? null }) : NO_LINES),
    [layers, stops, scopeDay, focus],
  );
  const byId = useMemo(() => new Map((graph.data?.nodes ?? []).map((n) => [n.id, n])), [graph.data]);

  // Frame the map when the route, the day or the focus changes, once both queries are in.
  const ready = Boolean(graph.data && route.data);
  const fitPoints = useMemo<[number, number][]>(() => {
    if (focus && focus.found > 0) return focus.points;
    const pts = items.map((i) => [i.lon, i.lat] as [number, number]);
    return pts.length ? pts : stops.map((s) => [s.city.lon, s.city.lat]);
  }, [focus, items, stops]);
  const fit = ready ? { key: `${routeId}|${day ?? ""}|${focusRaw ?? ""}`, points: fitPoints } : null;

  const visible = useMemo(
    () => (inViewOnly && view && !unavailable ? items.filter((i) => inBounds([i.lon, i.lat], view)) : items),
    [items, inViewOnly, view, unavailable],
  );
  const selectedItem = selected ? items.find((i) => i.id === selected) : undefined;

  useEffect(() => {
    if (selected) card.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const toggle = (layer: MapLayer) =>
    setLayers((prev) => {
      const next = new Set(prev);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });

  const pointCount = items.filter((i) => i.type !== "stop").length;
  // Stay prices follow the map's viewport; before the map reports one (or when it cannot draw), the box around the route's stops.
  const stopView = useMemo<Bounds | null>(() => {
    if (!stops.length) return null;
    const lons = stops.map((s) => s.city.lon);
    const lats = stops.map((s) => s.city.lat);
    return [
      [Math.min(...lons) - 0.5, Math.min(...lats) - 0.5],
      [Math.max(...lons) + 0.5, Math.max(...lats) + 0.5],
    ];
  }, [stops]);
  const heat = useStayHeat(tripId, stayOn, view ?? stopView);

  return (
    <>
      <BoardHeader
        eyebrow={`${trip.data?.trip.name ?? "Trip"} · map`}
        title={route.data?.route.name ?? "Map"}
        meta={
          <>
            <BoardStat label="Stops" value={stops.length} />
            <BoardStat label="On the map" value={pointCount} />
            <BoardStat label="Not on the map" value={unplaced} />
          </>
        }
      />
      <main className="mx-auto max-w-6xl space-y-3 px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Route"
            className="max-w-full"
            value={routeId}
            onChange={(e) => {
              setSelected(null);
              setParams({ route: e.target.value, day: null, focus: null });
            }}
          >
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.isCurrent ? " (current)" : ""}
              </option>
            ))}
          </Select>
          <Select aria-label="Day" className="max-w-full" value={scopeDay ? day ?? "" : ""} onChange={(e) => setParams({ day: e.target.value || null })}>
            <option value="">All days</option>
            {days.map((d) => (
              <option key={d.date} value={d.date}>
                {d.label} · {dayDate(d.date)}
              </option>
            ))}
          </Select>
          <Input
            type="search"
            aria-label="Search the map"
            placeholder="Search places"
            className="w-full sm:w-56"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <fieldset className="flex flex-wrap gap-x-3 gap-y-1.5 text-sm" data-testid="map-layers">
          <legend className="sr-only">Layers</legend>
          {MAP_LAYERS.map((layer) => (
            <label key={layer} className="inline-flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={layers.has(layer)} onChange={() => toggle(layer)} className="accent-[#0f151d]" />
              {LAYER_GLYPH[layer].map((g) => (
                <ShapeGlyph key={g.shape} shape={g.shape} color={g.color} n={1} className="h-3.5 w-3.5" />
              ))}
              <span>{MAP_LAYER_LABEL[layer]}</span>
            </label>
          ))}
          <StayToggle
            checked={stayOn}
            onChange={(on) => {
              setStayOn(on);
              if (!on) setStayCell(null);
            }}
          />
        </fieldset>
        <StayLegend heat={heat} enabled={stayOn} />
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-soft">
          <span>Colour is the first tag:</span>
          {[...ACTIVITY_TAGS, "other" as const].map((t) => (
            <span key={t} className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: TAG_COLOR[t] }} />
              {TAG_LABEL[t]}
            </span>
          ))}
          <span>· size is votes · hotels filled when booked or chosen</span>
        </p>

        {focus ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-stamp/40 bg-stamp/5 px-3 py-2 text-sm" data-testid="map-focus-bar" role="status">
            <span>
              {focus.found > 0
                ? `Showing ${focus.found} place${focus.found === 1 ? "" : "s"} from the assistant`
                : "The places from the assistant aren't on the map"}
            </span>
            <span aria-hidden>·</span>
            <button type="button" className="font-medium text-sky hover:underline" onClick={() => setParams({ focus: null })}>
              Show everything
            </button>
          </div>
        ) : null}
        {scopeDay ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft" data-testid="map-day-bar">
            <span>
              Showing {days.find((d) => d.date === scopeDay.date)?.label}, {dayDate(scopeDay.date)}
            </span>
            <button type="button" className="font-medium text-sky hover:underline" onClick={() => setParams({ day: null })}>
              All days
            </button>
          </div>
        ) : null}
        {unplaced > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="map-unplaced">
            <span>Not on the map yet: {unplaced}</span>
            <Link href={`/trips/${tripId}/library`} className="text-sky hover:underline">
              {isOwner ? "Find places in Activities" : "See them in Activities"}
            </Link>
          </div>
        ) : null}
        {graph.error ? <ErrorNote error={graph.error} /> : null}
        {route.error ? <ErrorNote error={route.error} /> : null}

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div
            className="relative h-80 min-w-0 overflow-hidden rounded-2xl border border-line bg-paper-2 sm:h-[28rem] lg:h-[calc(100vh-14rem)] lg:min-h-[30rem]"
            role="region"
            aria-label="Map of the trip"
            data-testid="map-region"
          >
            {unavailable ? (
              <p className="p-4 text-sm text-ink-soft">{unavailable}</p>
            ) : (
              <TripMap
                items={items}
                segments={segments}
                selected={selected}
                fit={fit}
                fly={fly}
                onSelect={setSelected}
                onView={setView}
                onUnavailable={setUnavailable}
                stay={{ data: heat.features, visible: stayOn }}
                onStayPick={setStayCell}
              />
            )}
            {!ready && !unavailable ? (
              <div className="absolute left-2 top-2 rounded-md bg-card/90 px-2 py-1">
                <Spinner />
              </div>
            ) : null}
          </div>

          <aside className="min-w-0 space-y-3 lg:max-h-[calc(100vh-14rem)] lg:min-h-[30rem] lg:overflow-y-auto">
            {stayOn && stayCell ? (
              <StayCellCard cell={stayCell} cityName={heat.data?.cities.find((c) => c.cityCode === stayCell.city)?.cityName} onClose={() => setStayCell(null)} />
            ) : null}
            <div ref={card}>
              {selectedItem ? (
                <DetailCard
                  key={selectedItem.id}
                  item={selectedItem}
                  node={byId.get(selectedItem.id)}
                  stop={selectedItem.type === "stop" ? stops.find((s) => `stop:${s.id}` === selectedItem.id) : undefined}
                  itinerary={itinerary}
                  routeId={routeId}
                  canEdit={canEdit}
                  onClose={() => setSelected(null)}
                />
              ) : null}
            </div>
            <section className="rounded-2xl border border-line bg-card" aria-labelledby="map-list-title">
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                <h2 id="map-list-title" className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">
                  On the map
                </h2>
                <span className="text-xs text-ink-faint" data-testid="map-list-count">
                  {visible.length === items.length ? `${items.length}` : `${visible.length} of ${items.length} in view`}
                </span>
                {view && !unavailable && items.length ? (
                  <button type="button" className="ml-auto text-xs font-medium text-sky hover:underline" onClick={() => setInViewOnly((v) => !v)}>
                    {inViewOnly ? "List everything" : "Only what's in view"}
                  </button>
                ) : null}
              </div>
              {truncated ? <p className="px-3 pt-2 text-xs text-ink-faint">Showing the first 500. Search or pick a day to narrow it down.</p> : null}
              {visible.length ? (
                <ul className="divide-y divide-line" aria-label="Places on the map" data-testid="map-list">
                  {visible.map((i) => (
                    <li key={i.id}>
                      <button
                        type="button"
                        className={`flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left text-sm hover:bg-paper-2 focus-visible:bg-paper-2 ${
                          i.id === selected ? "bg-paper-2" : ""
                        }`}
                        aria-label={describeItem(i)}
                        aria-current={i.id === selected ? "true" : undefined}
                        data-testid="map-list-item"
                        data-node-id={i.id}
                        data-type={i.type}
                        data-city={i.cityCode}
                        data-focused={i.focused ? "true" : undefined}
                        onClick={() => {
                          setSelected(i.id);
                          setFly({ key: Date.now(), id: i.id });
                        }}
                      >
                        <ShapeGlyph shape={i.shape} color={i.color} n={i.n} className="mt-0.5 h-4 w-4" />
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate ${i.focused ? "font-semibold" : "font-medium"}`}>{i.label}</span>
                          <span className="block truncate text-xs text-ink-soft">
                            {itemKind(i)}
                            {i.cityName && i.layer !== "route" ? ` · ${i.cityName}` : ""}
                            {i.votes ? ` · ${i.votes} vote${Math.abs(i.votes) === 1 ? "" : "s"}` : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-3 text-sm text-ink-faint" data-testid="map-list-empty">
                  {!ready ? "Loading…" : items.length ? "Nothing in view. Zoom out or list everything." : "Nothing matches."}
                </p>
              )}
            </section>
          </aside>
        </div>
      </main>
    </>
  );
}

export default function MapPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const trip = useTrip(tripId);
  return (
    <>
      <TopBar>
        <TripNav tripId={tripId} tripName={trip.data?.trip.name} />
      </TopBar>
      <RequireAuth>
        <Suspense fallback={<Spinner />}>
          <MapTab tripId={tripId} />
        </Suspense>
      </RequireAuth>
    </>
  );
}
