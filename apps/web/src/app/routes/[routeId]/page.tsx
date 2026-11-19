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
import { BoardHeader, BoardStat, RequireAuth, TopBar } from "@/components/shell";
import { StopCard } from "@/components/stop-card";
import { Timeline } from "@/components/timeline";
import { useToast } from "@/components/toast";
import { TripNav } from "@/components/trip-nav";
import { Button, ChecksBadge, ErrorNote, Spinner, Tag } from "@/components/ui";
import { download } from "@/lib/api";
import { useRoute, useRouteEdit, useRouteLibrary } from "@/lib/queries";

const RouteMap = dynamic(() => import("@/components/route-map"), {
  ssr: false,
  loading: () => <div className="h-64 animate-pulse rounded-2xl border border-line bg-paper-2 sm:h-80" />,
});

function Editor({ view }: { view: RouteView }) {
  const routeId = view.route.id;
  const canEdit = hasRole(view.role, "editor");
  const edit = useRouteEdit(routeId);
  const library = useRouteLibrary(routeId);
  const toast = useToast();
  const [drawerStop, setDrawerStop] = useState<string | null>(null);
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

  return (
    <>
      <BoardHeader
        eyebrow={`${view.trip.name} · route`}
        title={view.route.name}
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
            <div className="flex flex-wrap gap-1.5">
              {view.route.isCurrent ? <Tag tone="board">current</Tag> : null}
              {view.route.tags.filter((t) => !(view.route.isCurrent && t === "current")).map((t) => (
                <Tag key={t} tone="board">
                  {t}
                </Tag>
              ))}
            </div>
          </>
        }
        actions={
          <>
            <Link href={`/trips/${view.trip.id}`}>
              <Button size="sm">All routes</Button>
            </Link>
            <Link href={`/trips/${view.trip.id}/compare?a=${routeId}`}>
              <Button size="sm">Compare</Button>
            </Link>
            <Link href={`/trips/${view.trip.id}/graph?scope=route&route=${routeId}`}>
              <Button size="sm">View as graph</Button>
            </Link>
            <Button size="sm" onClick={() => void download(`/routes/${routeId}/export.txt`, "itinerary.txt").catch((e) => toast(String(e.message), "error"))}>
              Export text
            </Button>
            <Button size="sm" onClick={() => void download(`/routes/${routeId}/export.ics`, "itinerary.ics").catch((e) => toast(String(e.message), "error"))}>
              Export calendar
            </Button>
          </>
        }
      />
      <main className="mx-auto grid grid-cols-1 max-w-6xl gap-5 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-4 lg:col-start-2 lg:row-start-1">
          <RouteMap stops={view.stops} />
          <Timeline view={view} />
        </div>

        <section className="space-y-3 lg:col-start-1 lg:row-span-2 lg:row-start-1" aria-label="Stops">
          {!canEdit ? (
            <p className="rounded-lg bg-paper-2 px-3 py-2 text-sm text-ink-soft">
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

        <div className="lg:col-start-2 lg:row-start-2">
          <div className="space-y-4">
            <ChecksPanel view={view} />
            <BudgetPanel view={view} />
          </div>
        </div>
      </main>
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
  const route = useRoute(routeId);
  return (
    <>
      <TopBar>
        {route.data ? <TripNav tripId={route.data.trip.id} tripName={route.data.trip.name} /> : null}
        {route.data ? (
          <span className="ml-auto hidden sm:inline">
            <ChecksBadge level={route.data.checks.level} />
          </span>
        ) : null}
      </TopBar>
      <RequireAuth>
        <RouteScreen routeId={routeId} />
      </RequireAuth>
    </>
  );
}
