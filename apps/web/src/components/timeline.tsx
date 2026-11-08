"use client";

import type { RouteView } from "@trippr/contracts";
import { daysBetween, shortDate } from "@trippr/rules";

/** A strip sized by nights, coloured by country, with fixed-date events pinned on it. */
export function Timeline({ view }: { view: RouteView }) {
  const total = Math.max(view.checks.totalNights, 1);
  const events = view.stops.flatMap((s) =>
    s.planned
      .filter((p) => p.when && "on" in p.when)
      .map((p) => ({ id: `${s.id}-${p.id}`, title: p.title, on: (p.when as { on: string }).on })),
  );
  if (view.stops.length === 0) return null;
  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <div className="mb-2 flex items-center justify-between text-xs text-ink-soft">
        <span className="font-mono">{shortDate(view.trip.startDate)}</span>
        <span className="font-semibold uppercase tracking-[0.14em]">Timeline</span>
        <span className="font-mono">{shortDate(view.checks.returnDate)}</span>
      </div>
      <div className="relative">
        <ol className="flex h-12 w-full overflow-hidden rounded-lg" aria-label="Nights per stop">
          {view.stops.map((s) => (
            <li
              key={s.id}
              title={`${s.city.name}: ${s.nights} nights, ${shortDate(s.arrive)} to ${shortDate(s.depart)}`}
              className="flex min-w-[18px] flex-col items-center justify-center border-r border-card/70 text-white last:border-r-0"
              style={{ flexGrow: Math.max(s.nights, 0.35), flexBasis: 0, background: s.country.color ?? "#59626e" }}
            >
              <span className="font-mono text-[10px] font-semibold leading-none">{s.city.code}</span>
              <span className="text-[10px] leading-none opacity-80">{s.nights}</span>
            </li>
          ))}
        </ol>
        {events.map((e) => {
          const offset = daysBetween(view.trip.startDate, e.on) / total;
          if (offset < 0 || offset > 1) return null;
          return (
            <span
              key={e.id}
              title={`${e.title}, ${shortDate(e.on)}`}
              className="absolute -bottom-2 h-3 w-3 -translate-x-1/2 rotate-45 border-2 border-card bg-stamp"
              style={{ left: `${offset * 100}%` }}
            />
          );
        })}
      </div>
      {events.length ? (
        <p className="mt-3 text-[11px] text-ink-soft">
          <span className="mr-1 inline-block h-2 w-2 rotate-45 bg-stamp" /> fixed-date events
        </p>
      ) : null}
    </div>
  );
}
