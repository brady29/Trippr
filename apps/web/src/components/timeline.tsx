"use client";

import type { RouteView } from "@trippr/contracts";
import { daysBetween, shortDate } from "@trippr/rules";
import { routeHref } from "@/lib/routes";

/**
 * A strip sized by nights, coloured by country, with fixed-date events pinned
 * on it. On the board (under the route header) each stop jumps to its card.
 */
export function Timeline({ view, variant = "card" }: { view: RouteView; variant?: "card" | "board" | "inline" }) {
  const total = Math.max(view.checks.totalNights, 1);
  const events = view.stops.flatMap((s) =>
    s.planned
      .filter((p) => p.when && "on" in p.when)
      .map((p) => ({ id: `${s.id}-${p.id}`, title: p.title, on: (p.when as { on: string }).on })),
  );
  if (view.stops.length === 0) return null;
  const board = variant === "board";

  const strip = (
    <div className="relative">
      <ol className={`flex w-full gap-px overflow-hidden rounded-md ${board ? "h-9" : "h-12"}`} aria-label="Nights per stop">
        {view.stops.map((s) => (
          <li
            key={s.id}
            className="flex min-w-[18px]"
            style={{ flexGrow: Math.max(s.nights, 0.35), flexBasis: 0 }}
          >
            <a
              href={routeHref(view.trip.id, view.route.id, `stop-${s.id}`)}
              title={`${s.city.name}: ${s.nights} nights, ${shortDate(s.arrive)} to ${shortDate(s.depart)}`}
              aria-label={`${s.city.name}, ${s.nights} night${s.nights === 1 ? "" : "s"}`}
              onClick={(e) => {
                // On the route page, scroll to the card; elsewhere, follow the link to it.
                const card = document.getElementById(`stop-${s.id}`);
                if (!card) return;
                e.preventDefault();
                card.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className="flex w-full flex-col items-center justify-center text-white hover:brightness-110 focus-visible:outline-offset-0"
              style={{ background: s.country.color ?? "#5b616b" }}
            >
              <span className="font-mono text-[10px] font-semibold leading-none">{s.city.code}</span>
              <span className="text-[10px] leading-none opacity-80">{s.nights}</span>
            </a>
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
            className={`absolute -bottom-1.5 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-2 bg-stamp ${board ? "border-board-2" : "border-card"}`}
            style={{ left: `${offset * 100}%` }}
          />
        );
      })}
    </div>
  );

  if (board) {
    return (
      <div className="border-t border-board-3 bg-board-2">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 pb-3.5 pt-2.5 sm:px-6">
          <span className="hidden font-mono text-[11px] text-amber-soft/70 sm:block">{shortDate(view.trip.startDate)}</span>
          <div className="min-w-0 flex-1">{strip}</div>
          <span className="hidden font-mono text-[11px] text-amber-soft/70 sm:block">{shortDate(view.checks.returnDate)}</span>
        </div>
      </div>
    );
  }

  if (variant === "inline") {
    return (
      <div>
        {strip}
        <div className="mt-2 flex justify-between font-mono text-[11px] text-ink-soft">
          <span>{shortDate(view.trip.startDate)}</span>
          <span>{shortDate(view.checks.returnDate)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <div className="mb-2 flex items-center justify-between text-xs text-ink-soft">
        <span className="font-mono">{shortDate(view.trip.startDate)}</span>
        <span className="font-semibold uppercase tracking-[0.14em]">Timeline</span>
        <span className="font-mono">{shortDate(view.checks.returnDate)}</span>
      </div>
      {strip}
      {events.length ? (
        <p className="mt-3 text-[11px] text-ink-soft">
          <span className="mr-1 inline-block h-2 w-2 rotate-45 bg-stamp" /> fixed-date events
        </p>
      ) : null}
    </div>
  );
}
