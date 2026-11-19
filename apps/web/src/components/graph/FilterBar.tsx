"use client";

import type { GraphJSON, LegStatus } from "@trippr/contracts";
import type { GraphUrlState } from "@/lib/graph";

/** Routes, countries, leg status and "planned only" (types and tags live in the legend). */
export function FilterBar({
  graph,
  state,
  update,
  onClear,
  activeCount,
}: {
  graph: GraphJSON;
  state: GraphUrlState;
  update(patch: Partial<GraphUrlState>): void;
  onClear(): void;
  activeCount: number;
}) {
  const countries = graph.nodes.filter((n) => n.type === "country").sort((a, b) => a.label.localeCompare(b.label));
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const chip = (active: boolean) =>
    `min-h-9 rounded-full border px-2.5 py-1 text-xs ${active ? "border-ink bg-ink text-paper" : "border-line bg-card text-ink-soft hover:border-ink-faint"}`;
  const hasLegs = graph.nodes.some((n) => n.type === "leg");

  return (
    <div className="flex flex-col gap-3 text-sm lg:flex-row lg:flex-wrap lg:items-end lg:gap-x-6" aria-label="Filters">
      {graph.meta.routes.length > 1 ? (
        <fieldset className="flex flex-wrap items-center gap-1.5">
          <legend className="mb-1 w-full text-[11px] font-medium uppercase tracking-wide text-ink-faint lg:mb-0 lg:mr-1 lg:w-auto">Routes</legend>
          {graph.meta.routes.map((r) => (
            <button key={r.id} type="button" aria-pressed={state.routes.includes(r.id)} className={chip(state.routes.includes(r.id))} onClick={() => update({ routes: toggle(state.routes, r.id) })}>
              {r.name}
              {r.isCurrent ? " ·current" : ""}
            </button>
          ))}
        </fieldset>
      ) : null}
      {countries.length > 1 ? (
        <fieldset className="flex flex-wrap items-center gap-1.5">
          <legend className="mb-1 w-full text-[11px] font-medium uppercase tracking-wide text-ink-faint lg:mb-0 lg:mr-1 lg:w-auto">Countries</legend>
          {countries.map((c) => (
            <button key={c.id} type="button" aria-pressed={state.countries.includes(c.id)} className={chip(state.countries.includes(c.id))} onClick={() => update({ countries: toggle(state.countries, c.id) })}>
              <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: c.style.color ?? "#59626E" }} aria-hidden="true" />
              {c.label}
            </button>
          ))}
        </fieldset>
      ) : null}
      {hasLegs ? (
        <fieldset className="flex flex-wrap items-center gap-1.5">
          <legend className="mb-1 w-full text-[11px] font-medium uppercase tracking-wide text-ink-faint lg:mb-0 lg:mr-1 lg:w-auto">Leg status</legend>
          {(["idea", "held", "booked"] as LegStatus[]).map((s) => (
            <button key={s} type="button" aria-pressed={state.legStatus.includes(s)} className={chip(state.legStatus.includes(s))} onClick={() => update({ legStatus: toggle(state.legStatus, s) })}>
              {s}
            </button>
          ))}
        </fieldset>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex min-h-9 items-center gap-2 text-xs text-ink-soft">
          <input type="checkbox" className="h-4 w-4" checked={state.plannedOnly} onChange={(e) => update({ plannedOnly: e.target.checked })} />
          Planned only
        </label>
        {activeCount > 0 ? (
          <button type="button" className="min-h-9 text-xs font-medium text-sky hover:underline" onClick={onClear}>
            Clear filters ({activeCount})
          </button>
        ) : null}
      </div>
    </div>
  );
}
