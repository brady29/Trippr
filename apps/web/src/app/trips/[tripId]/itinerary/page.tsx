"use client";

import { DndContext, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { hasRole } from "@trippr/contracts";
import { buildItinerary, dayDate, type DayKind, type ItineraryDay, type ItineraryItem, type ItineraryLeg, type ItineraryStop } from "@trippr/rules";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { CalendarFeedPanel } from "@/components/calendar-feed";
import { CalendarIcon, ModeIcon } from "@/components/icons";
import { BoardHeader, BoardStat, RequireAuth } from "@/components/shell";
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
  return (
    <section
      ref={drop.setNodeRef}
      className={`rounded-2xl border bg-paper p-3 transition-colors ${drop.isOver ? "border-sky bg-sky/5" : "border-line"}`}
      data-testid="itinerary-day"
      data-date={day.date}
      data-kind={day.kind}
      aria-label={`Day ${day.index}, ${dayDate(day.date)}`}
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-xs font-semibold text-ink-soft">Day {day.index}</span>
        <h2 className="font-semibold">{dayDate(day.date)}</h2>
        <span className="text-sm text-ink-soft">{day.cityName ?? "Heading home"}</span>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_STYLE[day.kind]}`}>{KIND_LABEL[day.kind]}</span>
      </header>
      {day.stay ? (
        <p className="mt-1 text-xs text-ink-soft">
          Sleeping at {day.stay.name}
          {day.stay.status === "booked" ? " (booked)" : ""}
        </p>
      ) : null}
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
        <div className="mt-3 rounded-xl border border-dashed border-line p-2.5" data-testid="unscheduled">
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">
            Planned in {stop.cityName}, not on a day yet
          </div>
          <ul className="space-y-1.5">
            {[...stop.needsNewDay, ...stop.unscheduled].map((it) => (
              <ItemRow key={it.activityId} item={it} stop={stop} canEdit={canEdit} plan={plan} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
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

  const days = itinerary?.days ?? [];
  const clashes = days.reduce((n, d) => n + d.items.filter((i) => i.conflicts.length).length, 0);
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
      />
      <main className="mx-auto max-w-3xl space-y-3 px-4 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Route"
            value={routeId}
            onChange={(e) => router.replace(`/trips/${tripId}/itinerary?route=${encodeURIComponent(e.target.value)}`)}
          >
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.isCurrent ? " (current)" : ""}
              </option>
            ))}
          </Select>
          {routeId ? (
            <Link href={routeHref(tripId, routeId)} className="text-sm text-sky hover:underline">
              Edit this route
            </Link>
          ) : null}
          <Button size="sm" className="ml-auto" onClick={() => setCalendarOpen((o) => !o)} aria-expanded={calendarOpen}>
            <CalendarIcon className="h-3.5 w-3.5" />
            Add to calendar
          </Button>
        </div>
        {canEdit ? <p className="text-xs text-ink-faint">Drag activities between the days of their stop.</p> : null}
        {calendarOpen ? <CalendarFeedPanel tripId={tripId} onClose={() => setCalendarOpen(false)} /> : null}
        {trip.isPending || route.isPending ? <Spinner /> : null}
        {route.error ? <ErrorNote error={route.error} /> : null}
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          {days.map((d) => (
            <DayCard key={d.date} day={d} stops={stops} canEdit={canEdit} plan={plan} />
          ))}
        </DndContext>
      </main>
    </>
  );
}

export default function ItineraryPage() {
  const { tripId } = useParams<{ tripId: string }>();
  return (
    <>
      <RequireAuth>
        <Suspense fallback={<Spinner />}>
          <Itinerary tripId={tripId} />
        </Suspense>
      </RequireAuth>
    </>
  );
}
