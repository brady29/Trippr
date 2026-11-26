"use client";

import type { RouteView } from "@trippr/contracts";
import { budgetFlows, effectiveStopCosts, overBudgetFixes, sankeyLayout, type BudgetFix, type NightsChange, type RuleLeg, type RuleStop } from "@trippr/rules";
import { useEffect, useMemo, useState } from "react";
import { cad } from "./budget-panel";
import { Button, Input } from "./ui";

const COLOR: Record<string, string> = { stay: "var(--color-sky)", travel: "var(--color-rail)", activities: "var(--color-stamp)" };
const W = 340;
const H = 230;
const LEFT = 74;
const RIGHT = 86;

/**
 * Where the money goes: the per-person total, split into stays, getting
 * around and activities, then into the cities. Booked money is solid,
 * estimates are hatched. With a budget target, going over it comes with ways
 * back under that move no booking.
 */
export function BudgetFlow({
  view,
  rules,
  home,
  canSetTarget,
  canEdit,
  onTarget,
  onFix,
}: {
  view: RouteView;
  rules: RuleStop[];
  home: RuleLeg[];
  /** Only the owner can set the trip's budget. */
  canSetTarget: boolean;
  canEdit: boolean;
  onTarget: (perPerson: number | null) => void;
  onFix: (changes: NightsChange[], label: string) => void;
}) {
  const [group, setGroup] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const people = view.trip.travellers ?? 1;
  const target = view.trip.budgetPerPerson ?? null;
  const [draft, setDraft] = useState(target != null ? String(target) : "");
  useEffect(() => setDraft(target != null ? String(target) : ""), [target]);

  const costed = useMemo(
    () =>
      view.stops.map((s) => {
        const c = effectiveStopCosts(s);
        return {
          id: s.id,
          cityName: s.city.name,
          nights: s.nights,
          stayCadPerNight: c.stayCadPerNight,
          arriveCostCad: c.arriveCostCad,
          planned: s.planned,
          stayBooked: s.stays.some((x) => x.status === "booked"),
          travelBooked: s.legs.some((l) => l.status === "booked" && l.priceCad != null),
        };
      }),
    [view.stops],
  );
  const flows = useMemo(() => budgetFlows(costed), [costed]);
  const { nodes, bands } = useMemo(() => sankeyLayout(flows, { width: W - LEFT - RIGHT, height: H - 20 }), [flows]);
  const fixes: BudgetFix[] = useMemo(() => {
    if (target == null || flows.total <= target) return [];
    const withCosts = rules.map((r, i) => ({ ...r, ...costed[i]!, planned: view.stops[i]!.planned }));
    return overBudgetFixes(view.trip.startDate, withCosts, target, home);
  }, [target, flows.total, rules, costed, view.stops, view.trip.startDate, home]);

  const money = (n: number) => cad(group ? n * people : n);
  const over = target != null ? flows.total - target : null;
  const focusBand = bands.find((b) => `${b.source}-${b.target}` === focus);
  const nodeLabel = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-card p-4" aria-label="Where the money goes" data-testid="budget-flow">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Where the money goes</h2>
        <div className="flex rounded-lg bg-paper-2 p-0.5 text-[11px] font-medium" role="tablist" aria-label="Show money">
          {[false, true].map((g) => (
            <button key={String(g)} role="tab" aria-selected={group === g} onClick={() => setGroup(g)} className={`rounded-md px-2 py-0.5 ${group === g ? "bg-card shadow-sm" : "text-ink-soft"}`}>
              {g ? `All ${people}` : "Per person"}
            </button>
          ))}
        </div>
      </div>

      {flows.total > 0 ? (
        <figure className="space-y-1.5">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Spending per person: ${nodes.filter((n) => n.column === 1).map((n) => `${n.label} ${cad(n.value)}`).join(", ")}`}>
            <defs>
              {Object.entries(COLOR).map(([k, c]) => (
                <pattern key={k} id={`hatch-${k}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="6" height="6" fill={c} opacity="0.18" />
                  <line x1="0" y1="0" x2="0" y2="6" stroke={c} strokeWidth="2.2" opacity="0.6" />
                </pattern>
              ))}
            </defs>
            <g transform={`translate(${LEFT}, 10)`}>
              {bands.map((b, i) => {
                const key = b.source === "total" ? b.target : b.source;
                const id = `${b.source}-${b.target}`;
                return (
                  <path
                    key={id}
                    d={b.path}
                    fill={b.booked ? COLOR[key] : `url(#hatch-${key})`}
                    fillOpacity={b.booked ? (focus && focus !== id ? 0.25 : 0.6) : focus && focus !== id ? 0.35 : 1}
                    stroke={focus === id ? "var(--color-ink)" : "none"}
                    strokeWidth="0.8"
                    onMouseEnter={() => setFocus(id)}
                    onMouseLeave={() => setFocus(null)}
                    className="flow-band"
                    style={{ animationDelay: `${i * 25}ms` }}
                    data-testid="flow-band"
                  />
                );
              })}
              {nodes.map((n) => (
                <g key={n.id}>
                  <rect x={n.x} y={n.y} width="10" height={Math.max(n.h, 1.5)} rx="2" fill={n.column === 1 ? COLOR[n.id] : "var(--color-ink)"} />
                  {n.column === 0 ? (
                    <>
                      <text x={n.x - 6} y={n.y + n.h / 2 - 3} textAnchor="end" className="fill-ink-soft text-[10px]">
                        {group ? `All ${people}` : "Per person"}
                      </text>
                      <text x={n.x - 6} y={n.y + n.h / 2 + 10} textAnchor="end" className="fill-ink font-mono text-[11px] font-semibold">
                        {money(n.value)}
                      </text>
                      {target != null ? (
                        // The budget, as a tick on the total bar: above it is over.
                        <line
                          x1={n.x - 3}
                          x2={n.x + 13}
                          y1={n.y + n.h * Math.min(1, target / Math.max(flows.total, 1))}
                          y2={n.y + n.h * Math.min(1, target / Math.max(flows.total, 1))}
                          stroke={over != null && over > 0 ? "var(--color-err)" : "var(--color-ok)"}
                          strokeWidth="2.5"
                          data-testid="budget-tick"
                        />
                      ) : null}
                    </>
                  ) : n.column === 1 ? (
                    n.h > 14 ? (
                      <text x={n.x + 14} y={n.y + 11} className="fill-ink text-[10px] font-semibold" style={{ paintOrder: "stroke", stroke: "var(--color-card)", strokeWidth: 3 }}>
                        {n.label}
                      </text>
                    ) : null
                  ) : (
                    <text x={n.x + 14} y={n.y + Math.max(n.h, 8) / 2 + 3.5} className="fill-ink-soft text-[10px]">
                      {n.label} <tspan className="fill-ink font-mono">{money(n.value)}</tspan>
                    </text>
                  )}
                </g>
              ))}
            </g>
          </svg>
          <figcaption className="min-h-[1.25rem] text-xs text-ink-soft" aria-live="polite">
            {focusBand
              ? focusBand.source === "total"
                ? `${nodeLabel(focusBand.target)}: ${money(focusBand.value)}`
                : `${nodeLabel(focusBand.source)} in ${nodeLabel(focusBand.target)}: ${money(focusBand.value)}${focusBand.booked ? ", booked" : ", estimate"}`
              : "Solid is booked, hatched is an estimate. Point at a band for its amount."}
          </figcaption>
        </figure>
      ) : (
        <p className="rounded-xl bg-paper px-3 py-5 text-center text-sm text-ink-soft">Add costs or pick hotels and the flow fills in.</p>
      )}

      <div className="space-y-2 border-t border-line pt-3">
        {canSetTarget ? (
          <form
            className="flex items-center gap-2 text-xs"
            onSubmit={(e) => {
              e.preventDefault();
              const n = draft.trim() === "" ? null : Number(draft);
              if (n === null || (Number.isFinite(n) && n > 0)) onTarget(n);
            }}
          >
            <label htmlFor="budget-target" className="text-ink-soft">
              Budget per person
            </label>
            <div className="flex items-center rounded-md border border-line bg-paper pl-2">
              <span className="text-ink-faint">$</span>
              <Input id="budget-target" type="number" min={0} step="any" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="none" className="h-8 w-24 border-0 bg-transparent px-1 font-mono text-xs" />
            </div>
            <Button size="sm" type="submit">
              Set
            </Button>
          </form>
        ) : target != null ? (
          <p className="text-xs text-ink-soft">Budget per person: {cad(target)}</p>
        ) : null}
        {over != null ? (
          over > 0 ? (
            <div className="space-y-2 rounded-xl bg-err/10 px-3 py-2.5 text-xs" data-testid="over-budget">
              <p>
                <span className="font-semibold text-err">{cad(over)} per person over budget.</span> These keep every booking:
              </p>
              {fixes.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {fixes.map((f, i) => (
                    <Button key={f.label} size="sm" variant={i === 0 ? "primary" : "secondary"} disabled={!canEdit} onClick={() => onFix(f.changes, `${f.label}: saves ${cad(f.saves)} per person`)} data-testid="budget-fix">
                      {f.label} · saves {cad(f.saves)}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="text-ink-soft">No change to nights gets there without moving a booking; look for cheaper stays instead.</p>
              )}
            </div>
          ) : (
            <p className="text-xs text-ok" data-testid="under-budget">
              {cad(-over)} per person under budget.
            </p>
          )
        ) : null}
      </div>
    </section>
  );
}
