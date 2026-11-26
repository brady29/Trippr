"use client";

import type { RouteView, StopView } from "@trippr/contracts";
import { bestOrder, editImpact, type RuleLeg, type RuleStop } from "@trippr/rules";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { LineMap } from "./line-map";
import { Button } from "./ui";

const RouteMap = dynamic(() => import("./route-map"), {
  ssr: false,
  loading: () => <div className="h-56 animate-pulse rounded-2xl border border-line bg-paper-2" />,
});

const scrollToStop = (stopId: string) => document.getElementById(`stop-${stopId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });

/** The route as a map or as a line diagram, the choice remembered on this device. */
export function MapOrLine({ view, pinned }: { view: RouteView; pinned: Set<string> }) {
  const [mode, setMode] = useState<"map" | "line">("map");
  useEffect(() => {
    try {
      if (localStorage.getItem("trippr.mapView") === "line") setMode("line");
    } catch {
      // Storage blocked: the map is the default.
    }
  }, []);
  const pick = (m: "map" | "line") => {
    setMode(m);
    try {
      localStorage.setItem("trippr.mapView", m);
    } catch {
      // Not remembered, but still switches.
    }
  };
  // Replays the train along the line whenever the order changes.
  const playKey = view.stops.map((s) => s.id).join(",");
  return (
    <section className="space-y-2" aria-label="Route picture">
      <div className="flex gap-1 rounded-lg bg-paper-2 p-0.5 text-xs font-medium" role="tablist" aria-label="Show the route as">
        {(["map", "line"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => pick(m)}
            className={`flex-1 rounded-md px-2 py-1 ${mode === m ? "bg-card text-ink shadow-sm" : "text-ink-soft hover:text-ink"}`}
            data-testid={`view-${m}`}
          >
            {m === "map" ? "Map" : "Line"}
          </button>
        ))}
      </div>
      {mode === "map" ? (
        <RouteMap stops={view.stops} className="h-56" />
      ) : (
        <div className="rounded-2xl border border-line bg-card p-2">
          <LineMap lines={[{ stops: view.stops, color: "var(--color-ink)" }]} pinned={pinned} onStation={scrollToStop} playKey={playKey} label={`Line map of ${view.route.name}`} />
        </div>
      )}
    </section>
  );
}

const km = (n: number) => `${Math.round(n).toLocaleString("en-CA")} km`;

/**
 * Suggest a better order: the order with the least travel that keeps the
 * first stop first and moves no booking, shown as the line redrawn over the
 * old one. Apply reorders, with Undo.
 */
export function BetterOrder({
  view,
  rules,
  home,
  canEdit,
  onApply,
}: {
  view: RouteView;
  rules: RuleStop[];
  home: RuleLeg[];
  canEdit: boolean;
  onApply: (ids: string[], label: string) => void;
}) {
  const [result, setResult] = useState<{ ids: string[]; km: number; currentKm: number } | "same" | null>(null);
  // A new route version makes an old suggestion stale.
  const version = view.route.version;
  useEffect(() => setResult(null), [version]);
  const byId = useMemo(() => new Map(view.stops.map((s) => [s.id, s])), [view.stops]);

  if (!canEdit || view.stops.length < 3) return null;

  const suggest = () => {
    const ruleById = new Map(rules.map((r) => [r.id, r]));
    const best = bestOrder(
      view.stops.map((s) => ({ id: s.id, lat: s.city.lat, lon: s.city.lon })),
      (ids) => editImpact(view.trip.startDate, rules, ids.map((id) => ruleById.get(id)!), home).breaks.length === 0,
    );
    const saves = best.currentKm - best.km;
    setResult(saves >= 50 && saves / best.currentKm >= 0.03 ? best : "same");
  };

  const proposed: StopView[] | null = result && result !== "same" ? result.ids.map((id) => byId.get(id)!) : null;
  return (
    <section className="space-y-2.5 rounded-2xl border border-line bg-card p-4" aria-label="Suggest a better order" data-testid="better-order">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Less travel</h2>
        {!proposed ? (
          <Button size="sm" onClick={suggest} data-testid="suggest-order">
            Suggest a better order
          </Button>
        ) : null}
      </div>
      {result === "same" ? (
        <p className="text-xs text-ink-soft" data-testid="order-same">
          This is already the shortest order that starts in {view.stops[0]!.city.name} and keeps every booking.
        </p>
      ) : null}
      {proposed && result && result !== "same" ? (
        <>
          <p className="text-sm">
            <span className="font-semibold text-ok" data-testid="order-saves">
              Saves about {km(result.currentKm - result.km)}
            </span>{" "}
            <span className="text-ink-soft">
              ({km(result.currentKm)} → {km(result.km)}, as the crow flies). Every booking stays put.
            </span>
          </p>
          <LineMap lines={[{ stops: proposed, color: "var(--color-accent)" }]} ghost={view.stops} playKey={result.ids.join(",")} label="The suggested order" width={320} height={360} />
          <ol className="flex flex-wrap gap-1 text-xs text-ink-soft" aria-label="Suggested order">
            {proposed.map((s, i) => (
              <li key={s.id}>
                {i ? "→ " : ""}
                {s.city.name}
              </li>
            ))}
          </ol>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                onApply(result.ids, `Reordered to save about ${km(result.currentKm - result.km)}`);
                setResult(null);
              }}
              data-testid="apply-order"
            >
              Use this order
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setResult(null)}>
              Keep mine
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
