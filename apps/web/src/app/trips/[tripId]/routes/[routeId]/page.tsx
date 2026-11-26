"use client";

import { hasRole, type RouteView } from "@trippr/contracts";
import { shortDate } from "@trippr/rules";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ActivityDrawer } from "@/components/activity-drawer";
import { AddStop } from "@/components/add-stop";
import { BudgetPanel } from "@/components/budget-panel";
import { ChecksPanel } from "@/components/checks-panel";
import { FlightNotices } from "@/components/flight-prices";
import { BoardHeader, BoardStat, RequireAuth } from "@/components/shell";
import { StopCard } from "@/components/stop-card";
import { StopLegs } from "@/components/stop-legs";
import { TravelOptions } from "@/components/travel-options";
import { HotelDrawer, StaySummary } from "@/components/hotel-drawer";
import { Timeline } from "@/components/timeline";
import { useToast } from "@/components/toast";
import { ActionMenu, Button, ErrorNote, Spinner, Tag } from "@/components/ui";
import { download } from "@/lib/api";
import { useTripFlightPrices } from "@/lib/flights";
import { useRoute, useRouteEdit, useRouteLibrary } from "@/lib/queries";

const RouteMap = dynamic(() => import("@/components/route-map"), {
  ssr: false,
  loading: () => <div className="h-56 animate-pulse rounded-2xl border border-line bg-paper-2" />,
});

function Editor({ view }: { view: RouteView }) {
  const routeId = view.route.id;
  const canEdit = hasRole(view.role, "editor");
  const edit = useRouteEdit(routeId);
  const library = useRouteLibrary(routeId);
  const flightPrices = useTripFlightPrices(view.trip.id);
  const toast = useToast();
  const [drawerStop, setDrawerStop] = useState<string | null>(null);
  const [hotelStop, setHotelStop] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = view.stops.map((s) => s.id);
  const reorder = (stopIds: string[]) => edit.mutate({ kind: "reorder", stopIds });

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    reorder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  };

  const china = view.checks.visa.find((v) => v.countryIso === "CN");
  const drawer = view.stops.find((s) => s.id === drawerStop);
  const hotelDrawer = view.stops.find((s) => s.id === hotelStop);

  return (
    <>
      <BoardHeader
        eyebrow={`${view.trip.name} · route`}
        title={view.route.name}
        below={<Timeline view={view} variant="board" />}
        badges={
          <>
            {view.route.isCurrent ? <Tag tone="board">current</Tag> : null}
            {view.route.tags.filter((t) => !(view.route.isCurrent && t === "current")).map((t) => (
              <Tag key={t} tone="board">
                {t}
              </Tag>
            ))}
          </>
        }
        meta={
          <>
            <BoardStat label="Departs" value={shortDate(view.trip.startDate)} />
            <BoardStat label="Home" value={shortDate(view.checks.returnDate)} />
            <BoardStat label="Nights" value={view.checks.totalNights} />
            <BoardStat label="Stops" value={view.stops.length} />
            {china ? (
              <BoardStat
                label="China"
                value={china.entries.map((e) => `${e.days}/${china.limitDays}d`).join(" + ") || "none"}
              />
            ) : null}
          </>
        }
        actions={
          <>
            <Link href={`/trips/${view.trip.id}/compare?a=${routeId}`}>
              <Button size="sm" variant="board">Compare</Button>
            </Link>
            <Link href={`/trips/${view.trip.id}/graph?scope=route&route=${routeId}`}>
              <Button size="sm" variant="board">View as graph</Button>
            </Link>
            <ActionMenu
              label="Export"
              text="Export"
              onBoard
              actions={[
                {
                  label: "As text (.txt)",
                  onSelect: () => void download(`/routes/${routeId}/export.txt`, "itinerary.txt").catch((e) => toast(String(e.message), "error")),
                },
                {
                  label: "As a calendar (.ics)",
                  onSelect: () => void download(`/routes/${routeId}/export.ics`, "itinerary.ics").catch((e) => toast(String(e.message), "error")),
                },
              ]}
            />
          </>
        }
      />
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0 space-y-3" aria-label="Stops">
          {view.route.isCurrent ? <FlightNotices tripId={view.trip.id} /> : null}
          {!canEdit ? (
            <p className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink-soft">
              You&apos;re a viewer on this trip: you can vote and comment on activities, but not change the route.
            </p>
          ) : null}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <ol className="space-y-3">
                {view.stops.map((stop, i) => (
                  <StopCard
                    key={stop.id}
                    stop={stop}
                    index={i}
                    count={view.stops.length}
                    canEdit={canEdit}
                    libraryCount={library.data?.find((l) => l.stopId === stop.id)?.activities.length}
                    actions={{
                      onNights: (nights) => edit.mutate({ kind: "patchStop", stopId: stop.id, body: { nights } }),
                      onMode: (arriveMode) => edit.mutate({ kind: "patchStop", stopId: stop.id, body: { arriveMode } }),
                      onArriveNote: (arriveNote) => edit.mutate({ kind: "patchStop", stopId: stop.id, body: { arriveNote } }),
                      onNotes: (notes) => edit.mutate({ kind: "patchStop", stopId: stop.id, body: { notes } }),
                      onCosts: (costs) => edit.mutate({ kind: "patchStop", stopId: stop.id, body: costs }),
                      onMove: (delta) => reorder(arrayMove(ids, i, i + delta)),
                      onRemove: () => {
                        if (window.confirm(`Remove ${stop.city.name} from ${view.route.name}?`)) {
                          edit.mutate({ kind: "deleteStop", stopId: stop.id });
                        }
                      },
                      onOpenActivities: () => setDrawerStop(stop.id),
                    }}
                    getHere={(lead) => (
                      <>
                        <StopLegs
                          routeId={routeId}
                          stop={stop}
                          prevCityCode={view.stops[i - 1]?.city.code}
                          canEdit={canEdit}
                          pricesOn={flightPrices.data?.enabled === true}
                          lead={lead}
                        />
                        <TravelOptions
                          stop={stop}
                          prev={view.stops[i - 1]}
                          travellers={view.trip.travellers ?? 1}
                          canEdit={canEdit}
                          onUse={(o) =>
                            edit.mutate({
                              kind: "patchStop",
                              stopId: stop.id,
                              body: {
                                arriveMode: o.arriveMode,
                                arriveCostCad: o.costPerPersonCad,
                                ...(stop.arriveNote ? {} : { arriveNote: o.mode === "car" ? "Rental car" : o.mode === "bus" ? "Bus" : o.label }),
                              },
                            })
                          }
                        />
                      </>
                    )}
                    stay={<StaySummary stop={stop} onOpen={() => setHotelStop(stop.id)} />}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
          {view.stops.length === 0 ? (
            <p className="rounded-2xl border border-line bg-card px-4 py-6 text-center text-sm text-ink-soft">
              No stops yet. Add the first city below.
            </p>
          ) : null}
          {canEdit ? (
            <AddStop
              stops={view.stops}
              pending={edit.isPending}
              onAdd={(input) => edit.mutate({ kind: "addStop", body: input })}
            />
          ) : null}
        </section>

        <aside className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:self-start lg:overflow-y-auto lg:pb-1" aria-label="Route summary">
          <RouteMap stops={view.stops} className="h-56" />
          <ChecksPanel view={view} />
          <BudgetPanel view={view} />
        </aside>
      </main>
      {hotelDrawer ? (
        <HotelDrawer
          routeId={routeId}
          tripId={view.trip.id}
          stop={hotelDrawer}
          canEdit={canEdit}
          canVote={true}
          onClose={() => setHotelStop(null)}
        />
      ) : null}
      {drawer ? (
        <ActivityDrawer
          routeId={routeId}
          tripId={view.trip.id}
          stop={drawer}
          canEdit={canEdit}
          canVote={true}
          onClose={() => setDrawerStop(null)}
        />
      ) : null}
    </>
  );
}

function RouteScreen({ routeId }: { routeId: string }) {
  const route = useRoute(routeId);
  if (route.isPending) return <div className="mx-auto max-w-6xl px-4 py-8"><Spinner /></div>;
  if (route.error) return <div className="mx-auto max-w-6xl px-4 py-8"><ErrorNote error={route.error} /></div>;
  return <Editor view={route.data} />;
}

export default function RoutePage() {
  const { routeId } = useParams<{ routeId: string }>();
  return (
    <RequireAuth>
      <RouteScreen routeId={routeId} />
    </RequireAuth>
  );
}
