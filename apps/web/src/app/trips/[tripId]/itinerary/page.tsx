"use client";

import { DndContext, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { hasRole } from "@trippr/contracts";
import { buildItinerary, dayDate, type DayKind, type ItineraryDay, type ItineraryItem, type ItineraryLeg, type ItineraryStop } from "@trippr/rules";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { CalendarFeedPanel } from "@/components/calendar-feed";
import { CalendarIcon, ModeIcon } from "@/components/icons";
import { BoardHeader, BoardStat, Flaps, RequireAuth } from "@/components/shell";
import { useToast } from "@/components/toast";
import { Button, ErrorNote, Select, Spinner } from "@/components/ui";
import { usePlanDay, useRoute, useTrip } from "@/lib/queries";
import { routeHref } from "@/lib/routes";

const KIND_LABEL: Record<DayKind, string> = { travel: "Travel day", full: "Full", light: "Light", free: "Free day" };
const KIND_STYLE: Record<DayKind, string> = {
  travel: "bg-sky/15 text-sky",
  full: "bg-board text-amber",
  light: "bg-paper-2 text-ink-soft",
  free: "bg-ok/15 text-ok",
};
const DURATIONS = [30, 60, 90, 120, 180, 240, 360, 480];
const hours = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`.replace(".5 h", "½ h"));
const clock = (t: string | null | undefined) => (t && /T(\d{2}:\d{2})/.test(t) ? t.match(/T(\d{2}:\d{2})/)![1] : null);

type Plan = ReturnType<typeof usePlanDay>;

function ItemRow({
  item,
  stop,
  canEdit,
  plan,
}: {
  item: ItineraryItem;
  stop: ItineraryStop | undefined;
  canEdit: boolean;
  plan: Plan;
}) {
  const drag = useDraggable({ id: `${item.stopId}:${item.activityId}`, data: { item }, disabled: !canEdit });
  const set = (body: Parameters<Plan["mutate"]>[0]["body"]) => plan.mutate({ stopId: item.stopId, activityId: item.activityId, body });
  const style = drag.transform ? { transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)`, zIndex: 20 } : undefined;
  return (
    <li
      ref={drag.setNodeRef}
      style={style}
      className={`rounded-lg border border-line bg-card p-2.5 text-sm ${drag.isDragging ? "shadow-lg" : ""}`}
      data-testid="itinerary-item"
      data-activity={item.activityId}
    >
      <div className="flex items-start gap-2">
        {canEdit ? (
          <button
            {...drag.listeners}
            {...drag.attributes}
            className="mt-0.5 cursor-grab touch-none rounded px-1 text-ink-faint hover:text-ink"
            aria-label={`Drag ${item.title} to another day`}
          >
            ⋮⋮
          </button>
        ) : null}
        <span className="w-12 shrink-0 font-mono text-xs text-ink-soft">{item.startTime ?? "Any time"}</span>
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-snug">{item.title}</div>
          {item.durationMin ? <div className="text-xs text-ink-faint">{hours(item.durationMin)}</div> : null}
          {item.conflicts.map((c) => (
            <div key={c.kind} className="mt-0.5 text-xs font-medium text-stamp" data-testid="conflict">
              {c.message}
            </div>
          ))}
        </div>
      </div>
      {canEdit && stop ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Select
            aria-label={`Day for ${item.title}`}
            className="h-8 text-xs"
            value={stop.days.some((d) => d.stopDay === item.stopDay) ? String(item.stopDay) : ""}
            onChange={(e) => set({ day: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">Not on a day</option>
            {stop.days.map((d) => (
              <option key={d.stopDay} value={d.stopDay}>
                {dayDate(d.date)}
              </option>
            ))}
          </Select>
          <input
            key={item.startTime ?? "none"}
            type="time"
            aria-label={`Start time for ${item.title}`}
            className="h-8 rounded-lg border border-line bg-card px-2 text-xs"
            defaultValue={item.startTime ?? ""}
            onBlur={(e) => {
              const v = e.target.value || null;
              if (v !== item.startTime) set({ startTime: v });
            }}
          />
          <Select
            aria-label={`How long ${item.title} takes`}
            className="h-8 text-xs"
            value={item.durationMin ?? ""}
            onChange={(e) => set({ durationMin: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">Length</option>
            {DURATIONS.map((m) => (
              <option key={m} value={m}>
                {hours(m)}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </li>
  );
}

function LegRow({ leg }: { leg: ItineraryLeg }) {
  return (
    <li className="flex items-center gap-2 text-sm text-ink-soft" data-testid="itinerary-leg">
      <ModeIcon mode={leg.mode} className="h-4 w-4 shrink-0" />
      <span className="font-mono text-xs">{clock(leg.departAt) ?? "–"}</span>
      <span className="min-w-0 truncate">
        {leg.from.name} → {leg.to.name}
        {leg.number ? <span className="text-ink-faint"> · {leg.operator ? `${leg.operator} ` : ""}{leg.number}</span> : null}
      </span>
      <span className="ml-auto font-mono text-xs">{clock(leg.arriveAt) ? `arr ${clock(leg.arriveAt)}` : ""}</span>
    </li>
  );
}

function DayCard({
  day,
  stops,
  canEdit,
  plan,
}: {
  day: ItineraryDay;
  stops: Map<string, ItineraryStop>;
  canEdit: boolean;
  plan: Plan;
}) {
  const drop = useDroppable({ id: `day:${day.date}`, data: { stopId: day.stopId, stopDay: day.stopDay }, disabled: !day.stopId });
  const stop = day.stopId ? stops.get(day.stopId) : undefined;
  const firstDayOfStop = stop && day.stopDay === 1;
  const [weekday, ...rest] = dayDate(day.date).split(" ");
  return (
    <section
      ref={drop.setNodeRef}
      className={`grid grid-cols-[3.5rem_minmax(0,1fr)] gap-3 rounded-xl border bg-card p-3 transition-colors sm:grid-cols-[4.5rem_minmax(0,1fr)] ${
        drop.isOver ? "border-sky bg-sky/5" : "border-line"
      }`}
      data-testid="itinerary-day"
      data-date={day.date}
      data-kind={day.kind}
      aria-label={`Day ${day.index}, ${dayDate(day.date)}`}
    >
      {/* Date column, like the date on a ticket. */}
      <div className="border-r-2 border-dashed border-line pr-2 text-center">
        <div className="text-[9px] uppercase tracking-[0.18em] text-ink-faint">Day</div>
        <div className="font-mono text-2xl font-semibold leading-tight">{day.index}</div>
        <h2 className="mt-0.5 text-[11px] leading-tight text-ink-soft">
          <span className="block font-semibold text-ink">{weekday}</span>
          {rest.join(" ")}
          <span className="sr-only">, {day.cityName ?? "heading home"}</span>
        </h2>
      </div>
      <div className="min-w-0">
        <header className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_STYLE[day.kind]}`}>{KIND_LABEL[day.kind]}</span>
          {day.stay ? (
            <span className="truncate text-xs text-ink-soft">
              Sleeping at {day.stay.name}
              {day.stay.status === "booked" ? " (booked)" : ""}
            </span>
          ) : null}
        </header>
        {day.legs.length ? <ul className="mt-2 space-y-1">{day.legs.map((l) => <LegRow key={l.id} leg={l} />)}</ul> : null}
        {day.items.length ? (
          <ul className="mt-2 space-y-1.5">
            {day.items.map((it) => (
              <ItemRow key={it.activityId} item={it} stop={stops.get(it.stopId)} canEdit={canEdit} plan={plan} />
            ))}
          </ul>
        ) : day.kind === "free" ? (
          <p className="mt-2 text-sm text-ink-faint">Nothing planned yet.{canEdit ? " Drag an activity here." : ""}</p>
        ) : null}
        {firstDayOfStop && (stop.unscheduled.length || stop.needsNewDay.length) ? (
          <div className="mt-3 rounded-xl border border-dashed border-line bg-paper p-2.5" data-testid="unscheduled">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-soft">
              Planned in {stop.cityName}, not on a day yet
            </div>
            <ul className="space-y-1.5">
              {[...stop.needsNewDay, ...stop.unscheduled].map((it) => (
                <ItemRow key={it.activityId} item={it} stop={stop} canEdit={canEdit} plan={plan} />
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

interface StopGroup {
  key: string;
  cityName: string;
  code: string | null;
  days: ItineraryDay[];
}

/** Consecutive days in the same place, so each city gets one sticky header. */
function groupByStop(days: ItineraryDay[], codes: Map<string, string>): StopGroup[] {
  const groups: StopGroup[] = [];
  for (const d of days) {
    const key = d.stopId ?? "home";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.days.push(d);
    else groups.push({ key, cityName: d.cityName ?? "Heading home", code: d.stopId ? (codes.get(d.stopId) ?? null) : null, days: [d] });
  }
  return groups;
}

function Itinerary({ tripId }: { tripId: string }) {
  const trip = useTrip(tripId);
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const routes = trip.data?.routes ?? [];
  const routeId = params.get("route") ?? routes.find((r) => r.isCurrent)?.id ?? routes[0]?.id ?? "";
  const route = useRoute(routeId);
  const plan = usePlanDay(routeId);
  const canEdit = hasRole(trip.data?.role, "editor");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
  );

  const itinerary = useMemo(() => (route.data ? buildItinerary(route.data.stops) : null), [route.data]);
  const stops = useMemo(() => new Map((itinerary?.stops ?? []).map((s) => [s.stopId, s])), [itinerary]);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const item = active.data.current?.item as ItineraryItem | undefined;
    const target = over?.data.current as { stopId: string | null; stopDay: number | null } | undefined;
    if (!item || !target?.stopId || !target.stopDay) return;
    if (target.stopId !== item.stopId) {
      toast(`${item.title} stays with ${stops.get(item.stopId)?.cityName ?? "its stop"}. Pick one of its days.`);
      return;
    }
    if (item.stopDay === target.stopDay) return;
    plan.mutate({ stopId: item.stopId, activityId: item.activityId, body: { day: target.stopDay } });
  };

  const days = useMemo(() => itinerary?.days ?? [], [itinerary]);
  const clashes = days.reduce((n, d) => n + d.items.filter((i) => i.conflicts.length).length, 0);
  const codes = useMemo(() => new Map((route.data?.stops ?? []).map((s) => [s.id, s.city.code])), [route.data]);
  const groups = useMemo(() => groupByStop(days, codes), [days, codes]);
  return (
    <>
      <BoardHeader
        eyebrow={`${trip.data?.trip.name ?? "Trip"} · itinerary`}
        title={route.data?.route.name ?? "Itinerary"}
        meta={
          <>
            <BoardStat label="Days" value={days.length} />
            <BoardStat label="Travel days" value={days.filter((d) => d.kind === "travel").length} />
            <BoardStat label="Free days" value={days.filter((d) => d.kind === "free").length} />
            <BoardStat label="Clashes" value={clashes} />
          </>
        }
        actions={
          <>
            <select
              aria-label="Route"
              value={routeId}
              onChange={(e) => router.replace(`/trips/${tripId}/itinerary?route=${encodeURIComponent(e.target.value)}`)}
              className="h-8 max-w-[14rem] rounded-lg border border-board-3 bg-board-2 px-2 text-xs font-medium text-amber-soft focus:outline-none"
            >
              {routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.isCurrent ? " (current)" : ""}
                </option>
              ))}
            </select>
            <Button size="sm" variant="board" onClick={() => setCalendarOpen((o) => !o)} aria-expanded={calendarOpen}>
              <CalendarIcon className="h-3.5 w-3.5" />
              Add to calendar
            </Button>
          </>
        }
      />
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* Stops down the side on wide screens, to jump through a long trip. */}
        <nav aria-label="Jump to a stop" className="hidden lg:sticky lg:top-4 lg:block lg:max-h-[calc(100dvh-2rem)] lg:self-start lg:overflow-y-auto">
          <ol className="space-y-0.5 border-l-2 border-line">
            {groups.map((g) => (
              <li key={g.key}>
                <a href={`#stop-days-${g.key}`} className="-ml-0.5 flex items-baseline gap-2 border-l-2 border-transparent py-1 pl-3 text-sm hover:border-accent">
                  <span className="w-8 shrink-0 font-mono text-[11px] font-semibold text-ink-soft">{g.code ?? "—"}</span>
                  <span className="min-w-0 flex-1 truncate">{g.cityName}</span>
                  <span className="font-mono text-[11px] text-ink-faint">{g.days.length}d</span>
                </a>
              </li>
            ))}
          </ol>
          {routeId ? (
            <Link href={routeHref(tripId, routeId)} className="mt-3 inline-block pl-3 text-xs font-medium text-sky hover:underline">
              Edit this route
            </Link>
          ) : null}
        </nav>

        <div className="min-w-0 space-y-4">
          {calendarOpen ? <CalendarFeedPanel tripId={tripId} onClose={() => setCalendarOpen(false)} /> : null}
          {canEdit ? <p className="text-xs text-ink-faint">Drag activities between the days of their stop.</p> : null}
          {trip.isPending || route.isPending ? <Spinner /> : null}
          {route.error ? <ErrorNote error={route.error} /> : null}
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            {groups.map((g) => (
              <section key={g.key} id={`stop-days-${g.key}`} className="scroll-mt-2" aria-label={g.cityName}>
                <header className="sticky top-0 z-10 -mx-1 mb-2 flex items-center gap-2.5 bg-paper/95 px-1 py-2 backdrop-blur">
                  {g.code ? (
                    <span className="flaps-outlined text-[13px]" aria-hidden>
                      <Flaps text={g.code} />
                    </span>
                  ) : null}
                  <h2 className="font-semibold">{g.cityName}</h2>
                  <span className="font-mono text-xs text-ink-soft">
                    {dayDate(g.days[0]!.date)}
                    {g.days.length > 1 ? ` → ${dayDate(g.days[g.days.length - 1]!.date)}` : ""}
                  </span>
                </header>
                <div className="space-y-2">
                  {g.days.map((d) => (
                    <DayCard key={d.date} day={d} stops={stops} canEdit={canEdit} plan={plan} />
                  ))}
                </div>
              </section>
            ))}
          </DndContext>
        </div>
      </main>
    </>
  );
}

export default function ItineraryPage() {
  const { tripId } = useParams<{ tripId: string }>();
  return (
    <RequireAuth>
      <Suspense fallback={<Spinner />}>
        <Itinerary tripId={tripId} />
      </Suspense>
    </RequireAuth>
  );
}
