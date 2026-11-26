"use client";

import { hasRole, type City, type RouteView, type StopView } from "@trippr/contracts";
import {
  bookingNames,
  describeAnchors,
  editImpact,
  fixesFor,
  HOME,
  listNames,
  nextToBook,
  planInsert,
  planNights,
  shortDate,
  stopPace,
  type Check,
  type EditImpact,
  type Fix,
  type NextToBookItem,
  type NightsChange,
  type NightsPlan,
} from "@trippr/rules";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityDrawer } from "@/components/activity-drawer";
import { AddStop } from "@/components/add-stop";
import { ChangeBar, GuardDialog, impactParts, impactSentences, IssueStrip, nightsMessage, TradePanel, type Change, type Guard } from "@/components/anchors";
import { HomeCard } from "@/components/home-card";
import { BookedPrompt, NextToBook, useBookedPrompt } from "@/components/next-to-book";
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
import { ruleHome, ruleStops, useCitySearch, useRoute, useRouteEdit, useRouteLibrary, type RouteEdit } from "@/lib/queries";

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
  const start = view.trip.startDate;
  const rules = useMemo(() => ruleStops(view.stops), [view.stops]);
  const home = useMemo(() => ruleHome(view), [view]);
  const anchors = useMemo(() => describeAnchors(start, rules, home), [start, rules, home]);
  const hasBookings = anchors.anchors.some((a) => a.strength === "booked");
  // Checks that belong to a stop (or the trip home), each with the fixes the engine finds.
  const issues = useMemo(() => {
    const out = new Map<string, { check: Check; fixes: Fix[] }[]>();
    for (const check of view.checks.checks) {
      if (check.level !== "warn" && check.level !== "error") continue;
      const key = check.kind === "home-day" || check.kind === "return-window" ? HOME : check.stopId;
      if (!key) continue;
      out.set(key, [...(out.get(key) ?? []), { check, fixes: fixesFor(start, rules, check, home, view.trip.latestReturn) }]);
    }
    return out;
  }, [view.checks.checks, start, rules, home, view.trip.latestReturn]);
  const flightPricesData = flightPrices.data;
  const nextItems = useMemo(
    () =>
      nextToBook({
        startDate: start,
        stops: rules.map((r) => ({ ...r, arriveMode: r.view.arriveMode })),
        home,
        fareVerdicts:
          view.route.isCurrent && flightPricesData?.enabled ? Object.fromEntries(flightPricesData.items.map((i) => [i.stopId, i.verdict])) : {},
      }),
    [start, rules, home, view.route.isCurrent, flightPricesData],
  );
  const homeSearch = useCitySearch(view.trip.homeCity ?? "");
  const homeName = view.trip.homeCity?.trim().toLowerCase() ?? "";
  const homeCity = homeSearch.data?.find((c) => c.code.toLowerCase() === homeName || c.name.toLowerCase() === homeName);
  const prompt = useBookedPrompt();
  const [openLeg, setOpenLeg] = useState<{ stopId: string; n: number } | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    try {
      setCompact(localStorage.getItem("trippr.compact") === "1");
    } catch {
      // Storage can be blocked; the detailed view is the default.
    }
  }, []);
  const toggleCompact = () => {
    setCompact((c) => {
      try {
        localStorage.setItem("trippr.compact", c ? "0" : "1");
      } catch {
        // Not remembered, but still switches.
      }
      return !c;
    });
  };
  /** "I booked it": open the place to record it, the hotel drawer or the leg form. */
  const markBooked = (item: NextToBookItem) => {
    prompt.dismiss();
    if (item.kind === "stay" && item.stopId) return setHotelStop(item.stopId);
    const target = item.kind === "home" ? HOME : item.stopId!;
    setOpenLeg({ stopId: target, n: Date.now() });
    document.getElementById(target === HOME ? "home-card" : `stop-${target}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const planAdd = useCallback(
    (city: City, nights: number, position: number) =>
      planInsert(start, rules, { id: "new", nights, cityName: city.name, countryIso: city.countryIso, countryName: city.countryName, visaRule: null, view: rules[0]?.view as StopView }, position, home),
    [start, rules, home],
  );
  const [trade, setTrade] = useState<{ stopId: string; delta: number; plan: NightsPlan } | null>(null);
  const [guard, setGuard] = useState<Guard | null>(null);
  const [dragHint, setDragHint] = useState<string | null>(null);
  // Undo stack of this session's own edits: each entry knows how to put the route back.
  const [stack, setStack] = useState<{ message: string; inverse: RouteEdit }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // A stop added or removed (by anyone) makes old reorders meaningless, so the stack starts again.
  const stopCount = ids.length;
  useEffect(() => setStack([]), [stopCount]);

  const record = (message: string, inverse?: RouteEdit) => {
    if (inverse) setStack((s) => [...s, { message, inverse }].slice(-20));
    setNotice(message);
  };
  const undo = () => {
    const top = stack[stack.length - 1];
    if (!top) return;
    setStack((s) => s.slice(0, -1));
    edit.mutate(top.inverse, { onSuccess: () => setNotice(`Undone: ${top.message}`) });
  };
  const bar: Change | null = notice ? { id: 0, message: notice, undo: stack.length ? undo : undefined } : null;

  const setNights = (next: NightsChange[], impact: EditImpact) => {
    const message = nightsMessage(view.stops, next, impact, hasBookings);
    const inverse: RouteEdit = { kind: "setNights", nights: next.map((c) => ({ stopId: c.stopId, nights: view.stops.find((s) => s.id === c.stopId)!.nights })) };
    edit.mutate({ kind: "setNights", nights: next }, { onSuccess: () => record(message, inverse) });
    setTrade(null);
  };

  /** One more or one fewer night: straight away when no booking moves, otherwise ask. */
  const changeNights = (stopId: string, nights: number) => {
    const current = view.stops.find((s) => s.id === stopId)!;
    const delta = nights - current.nights;
    if (delta === 0 || nights < 0) return;
    const plan = planNights(start, rules, stopId, delta, home);
    if (plan.free) setNights(plan.shift.changes, plan.shift.impact);
    else setTrade({ stopId, delta, plan });
  };

  const reorderTo = (stopIds: string[], what: string) => {
    const byId = new Map(rules.map((r) => [r.id, r]));
    const impact = editImpact(start, rules, stopIds.map((id) => byId.get(id)!), home);
    const run = () => {
      const inverse: RouteEdit = { kind: "reorder", stopIds: ids };
      const message = [what, ...impactParts(impact, hasBookings)].join(" · ");
      edit.mutate({ kind: "reorder", stopIds }, { onSuccess: () => record(message, inverse) });
    };
    if (!impact.breaks.length) return run();
    setGuard({ title: `${what}?`, body: impactSentences(impact), confirmLabel: "Move it anyway", onConfirm: run });
  };

  const moveLabel = (stopIds: string[], movedId: string) => {
    const at = stopIds.indexOf(movedId);
    const name = (id?: string) => view.stops.find((s) => s.id === id)?.city.name;
    const moved = name(movedId);
    return at === 0 ? `Moved ${moved} to the start` : `Moved ${moved} after ${name(stopIds[at - 1])}`;
  };

  const removeStop = (stop: StopView) => {
    const impact = editImpact(start, rules, rules.filter((r) => r.id !== stop.id), home);
    const own = [
      ...stop.legs.filter((l) => l.status === "booked").map((l) => [l.operator, l.number].filter(Boolean).join(" ") || `${l.from.name} → ${l.to.name}`),
      ...stop.stays.filter((s) => s.status === "booked").map((s) => s.hotel.name),
    ];
    setGuard({
      title: `Remove ${stop.city.name} from ${view.route.name}?`,
      body: [
        own.length ? (
          <p key="own">
            <span className="font-medium text-ink">Its bookings go with it:</span> {listNames(own, 4)}. Cancel them with the provider if you need to.
          </p>
        ) : null,
        ...impactSentences(impact),
        <p key="undo">Its tickets and planned activities are removed from this route, and this can&apos;t be undone.</p>,
      ],
      confirmLabel: `Remove ${stop.city.name}`,
      onConfirm: () => edit.mutate({ kind: "deleteStop", stopId: stop.id }, { onSuccess: () => record(`Removed ${stop.city.name}`) }),
    });
  };

  const prospective = (active: string, over: string) => arrayMove(ids, ids.indexOf(active), ids.indexOf(over));

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || active.id === over.id) return setDragHint(null);
    const next = prospective(String(active.id), String(over.id));
    const byId = new Map(rules.map((r) => [r.id, r]));
    const broken = bookingNames(editImpact(start, rules, next.map((id) => byId.get(id)!), home).breaks);
    setDragHint(broken.length ? `Dropping here moves ${listNames(broken)} off ${broken.length === 1 ? "its" : "their"} booked dates` : hasBookings ? "Dropping here keeps every booking" : null);
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragHint(null);
    if (!over || active.id === over.id) return;
    const next = prospective(String(active.id), String(over.id));
    reorderTo(next, moveLabel(next, String(active.id)));
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
          {prompt.asking ? <BookedPrompt item={prompt.asking} onYes={() => markBooked(prompt.asking!)} onNo={prompt.dismiss} /> : null}
          {view.stops.length > 1 ? (
            <div className="flex justify-end">
              <button
                onClick={toggleCompact}
                aria-pressed={compact}
                className="rounded-lg border border-line bg-card px-2.5 py-1 text-xs font-medium text-ink-soft hover:text-ink"
                data-testid="compact-toggle"
              >
                {compact ? "Show full stops" : "Compact view"}
              </button>
            </div>
          ) : null}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={() => setDragHint(null)}
          >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              {dragHint ? (
                <p
                  className={`sticky top-2 z-20 rounded-lg px-3 py-2 text-xs font-medium shadow-lg ${dragHint.startsWith("Dropping here moves") ? "bg-err text-white" : "bg-ok text-white"}`}
                  role="status"
                  aria-live="polite"
                  data-testid="drag-hint"
                >
                  {dragHint}
                </p>
              ) : null}
              <ol className="space-y-3">
                {view.stops.map((stop, i) => (
                  <StopCard
                    key={stop.id}
                    stop={stop}
                    index={i}
                    count={view.stops.length}
                    canEdit={canEdit}
                    libraryCount={library.data?.find((l) => l.stopId === stop.id)?.activities.length}
                    lock={anchors.locks[stop.id]}
                    pins={anchors.anchors.filter((a) => a.stopId === stop.id)}
                    compact={compact}
                    pace={stopPace({ nights: stop.nights, arriveAt: stop.legs.at(-1)?.arriveAt, planned: stop.planned })}
                    issueCount={issues.get(stop.id)?.length ?? 0}
                    issues={issues.get(stop.id)?.map(({ check, fixes }) => (
                      <IssueStrip key={check.id} check={check} fixes={fixes} canEdit={canEdit} pending={edit.isPending} onFix={(f) => setNights(f.changes, f.impact)} />
                    ))}
                    trade={
                      trade?.stopId === stop.id ? (
                        <TradePanel
                          stop={stop}
                          stops={view.stops}
                          delta={trade.delta}
                          plan={trade.plan}
                          lock={anchors.locks[stop.id] ?? "free"}
                          pending={edit.isPending}
                          onPick={(o) => setNights(o.changes, o.impact)}
                          onCancel={() => setTrade(null)}
                        />
                      ) : undefined
                    }
                    actions={{
                      onNights: (nights) => changeNights(stop.id, nights),
                      onMode: (arriveMode) => edit.mutate({ kind: "patchStop", stopId: stop.id, body: { arriveMode } }),
                      onArriveNote: (arriveNote) => edit.mutate({ kind: "patchStop", stopId: stop.id, body: { arriveNote } }),
                      onNotes: (notes) => edit.mutate({ kind: "patchStop", stopId: stop.id, body: { notes } }),
                      onCosts: (costs) => edit.mutate({ kind: "patchStop", stopId: stop.id, body: costs }),
                      onMove: (delta) => {
                        const next = arrayMove(ids, i, i + delta);
                        reorderTo(next, moveLabel(next, stop.id));
                      },
                      onRemove: () => removeStop(stop),
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
                          openNew={openLeg?.stopId === stop.id ? openLeg.n : undefined}
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
          <div id="home-card" className="scroll-mt-4">
            <HomeCard
              view={view}
              pin={anchors.anchors.find((a) => a.stopId === HOME)}
              canEdit={canEdit}
              pricesOn={flightPrices.data?.enabled === true}
              openNew={openLeg?.stopId === HOME ? openLeg.n : undefined}
              onSearch={() => prompt.opened({ kind: "home", title: "Flight home", reasons: [], date: view.checks.returnDate, score: 0 })}
              issues={issues.get(HOME)?.map(({ check, fixes }) => (
                <IssueStrip key={check.id} check={check} fixes={fixes} canEdit={canEdit} pending={edit.isPending} onFix={(f) => setNights(f.changes, f.impact)} />
              ))}
            />
          </div>
          {canEdit ? (
            <AddStop
              stops={view.stops}
              pending={edit.isPending}
              plan={planAdd}
              onAdd={(input, tradeChanges) => edit.mutate({ kind: "addStop", body: { ...input, ...(tradeChanges?.length ? { alsoNights: tradeChanges } : {}) } })}
            />
          ) : null}
          <ChangeBar change={bar} depth={stack.length} onDismiss={() => setNotice(null)} />
        </section>

        <aside className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:self-start lg:overflow-y-auto lg:pb-1" aria-label="Route summary">
          <RouteMap stops={view.stops} className="h-56" />
          <NextToBook items={nextItems} view={view} homeCity={homeCity} canEdit={canEdit} onSearch={prompt.opened} onMark={markBooked} />
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
      {guard ? <GuardDialog guard={guard} onCancel={() => setGuard(null)} /> : null}
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
