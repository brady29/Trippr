"use client";

import type { RouteView } from "@trippr/contracts";
import { Panel } from "./ui";

export const cad = (n: number) =>
  n.toLocaleString("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });

/**
 * Per-person and group estimates in CAD: stays, getting between stops and
 * planned activities. Missing estimates count as zero and are listed, so the
 * totals are a floor, not a guess.
 */
export function BudgetPanel({ view }: { view: RouteView }) {
  const { budget } = view;
  const rows: [string, number, number][] = [
    ["Stays", budget.perPerson.stay, budget.group.stay],
    ["Getting around", budget.perPerson.travel, budget.group.travel],
    ["Planned activities", budget.perPerson.activities, budget.group.activities],
  ];
  const cityOf = (id: string) => view.stops.find((s) => s.id === id)?.city.name ?? id;
  const missingStays = budget.missing.stayStopIds.map(cityOf);
  const missingTravel = budget.missing.travelStopIds.map(cityOf);

  return (
    <Panel title="Budget (CAD)">
      <table className="w-full text-sm" data-testid="budget-table">
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.15em] text-ink-faint">
            <th className="pb-1 text-left font-medium" scope="col">
              <span className="sr-only">Category</span>
            </th>
            <th className="pb-1 text-right font-medium" scope="col">
              Per person
            </th>
            <th className="pb-1 text-right font-medium" scope="col">
              {budget.travellers} traveller{budget.travellers === 1 ? "" : "s"}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, each, group]) => (
            <tr key={label}>
              <th scope="row" className="py-1 text-left font-normal text-ink-soft">
                {label}
              </th>
              <td className="py-1 text-right font-mono">{cad(each)}</td>
              <td className="py-1 text-right font-mono text-ink-soft">{cad(group)}</td>
            </tr>
          ))}
          <tr className="border-t border-line">
            <th scope="row" className="pt-2 text-left font-semibold">
              Total
            </th>
            <td className="pt-2 text-right font-mono font-semibold" data-testid="budget-per-person">
              {cad(budget.perPerson.total)}
            </td>
            <td className="pt-2 text-right font-mono font-semibold">{cad(budget.group.total)}</td>
          </tr>
        </tbody>
      </table>
      {missingStays.length || missingTravel.length ? (
        <div className="mt-3 space-y-1 rounded-lg bg-warn/10 px-3 py-2 text-xs text-ink-soft">
          <p className="font-medium text-warn">Not estimated yet, so counted as $0:</p>
          {missingStays.length ? (
            <p>
              Stays for {budget.missing.stayNights} night{budget.missing.stayNights === 1 ? "" : "s"}: {missingStays.join(", ")}
            </p>
          ) : null}
          {missingTravel.length ? <p>Getting to: {missingTravel.join(", ")}</p> : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-ok">Every stay and leg has an estimate.</p>
      )}
    </Panel>
  );
}
