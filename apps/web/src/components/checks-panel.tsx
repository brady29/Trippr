"use client";

import type { RouteView } from "@trippr/contracts";
import { shortDate } from "@trippr/rules";
import { ChecksBadge, LevelIcon, Panel } from "./ui";

/** China visa-free days per entry against the limit, entries, fixed-date events, and the return date. */
export function ChecksPanel({ view }: { view: RouteView }) {
  const { checks } = view;
  const problems = checks.checks.filter((c) => c.kind !== "total-nights" && c.kind !== "return-date" && c.kind !== "visa-days");
  return (
    <Panel title="Checks" action={<ChecksBadge level={checks.level} />}>
      <dl className="mb-4 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-paper px-2 py-2">
          <dt className="text-[10px] uppercase tracking-[0.15em] text-ink-faint">Nights</dt>
          <dd className="font-mono text-lg font-semibold" data-testid="total-nights">
            {checks.totalNights}
          </dd>
        </div>
        <div className="rounded-lg bg-paper px-2 py-2">
          <dt className="text-[10px] uppercase tracking-[0.15em] text-ink-faint">Home</dt>
          <dd className="font-mono text-lg font-semibold" data-testid="return-date">
            {shortDate(checks.returnDate)}
          </dd>
        </div>
        <div className="rounded-lg bg-paper px-2 py-2">
          <dt className="text-[10px] uppercase tracking-[0.15em] text-ink-faint">Per person</dt>
          <dd className="font-mono text-lg font-semibold">${Math.round(view.budget.perPerson.total)}</dd>
        </div>
      </dl>

      {checks.visa.map((country) => (
        <div key={country.countryIso} className="mb-4">
          <div className="mb-2 flex items-baseline justify-between text-sm">
            <span className="font-medium">{country.countryName} visa-free</span>
            <span className="text-xs text-ink-soft">
              {country.entries.length} entr{country.entries.length === 1 ? "y" : "ies"} · limit {country.limitDays} days each
            </span>
          </div>
          <ul className="space-y-2">
            {country.entries.map((e, i) => {
              const pct = Math.min(100, (e.days / country.limitDays) * 100);
              return (
                <li key={i} data-testid="visa-entry">
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="truncate pr-2 text-ink-soft">
                      {shortDate(e.arrive)} to {shortDate(e.depart)} · {e.cities.join(", ")}
                    </span>
                    <span className={`font-mono font-semibold ${e.overLimit ? "text-err" : "text-ink"}`}>
                      {e.days}/{country.limitDays}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-paper-2" role="meter" aria-valuenow={e.days} aria-valuemin={0} aria-valuemax={country.limitDays} aria-label={`${country.countryName} entry ${i + 1} days`}>
                    <div className={`h-full rounded-full ${e.overLimit ? "bg-err" : pct > 85 ? "bg-warn" : "bg-ok"}`} style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {problems.length ? (
        <ul className="space-y-2.5">
          {problems.map((c) => (
            <li key={c.id} className="flex gap-2 text-sm">
              <LevelIcon level={c.level} className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <div className="font-medium">{c.title}</div>
                <div className="text-xs text-ink-soft">{c.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-soft">No fixed-date events planned yet.</p>
      )}
    </Panel>
  );
}
