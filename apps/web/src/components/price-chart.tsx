"use client";

import type { FlightPricePoint } from "@trippr/contracts";
import { shortDate } from "@trippr/rules";
import { useRef, useState, type KeyboardEvent } from "react";
import { cad } from "@/lib/flights";
import { chartGeometry, nearestPoint, type ChartBox } from "@/lib/price-chart";

const BOX: ChartBox = { width: 560, height: 190, left: 44, right: 14, top: 14, bottom: 26 };

/**
 * One line: the lowest price found for the planned date at each daily
 * snapshot. Hover or tap shows that day's price; the lowest and the latest
 * are labelled; a table of the same numbers sits below for anyone who
 * prefers it or cannot see the colour.
 */
export function PriceChart({ points, label }: { points: FlightPricePoint[]; label: string }) {
  const g = chartGeometry(points, BOX);
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  if (!g.points.length) return null;
  const shown = hover != null ? g.points[hover]! : null;

  const onMove = (clientX: number) => {
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const x = ((clientX - rect.left) / rect.width) * BOX.width;
    const p = nearestPoint(g.points, x);
    setHover(p ? g.points.indexOf(p) : null);
  };

  const step = (to: (i: number | null) => number) => setHover(to(hover));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = g.points.length;
    if (e.key === "ArrowLeft") step((i) => Math.max(0, (i ?? n) - 1));
    else if (e.key === "ArrowRight") step((i) => Math.min(n - 1, (i ?? -1) + 1));
    else if (e.key === "Home") step(() => 0);
    else if (e.key === "End") step(() => n - 1);
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };

  const { min, last } = g;
  // Keep labels inside the plot: flip to the left of a point near the right edge.
  const anchor = (x: number) => (x > BOX.width - 70 ? "end" : "start");
  const dx = (x: number) => (x > BOX.width - 70 ? -8 : 8);

  return (
    <div data-testid="price-chart">
      <div
        ref={wrap}
        className="relative touch-pan-y rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky"
        tabIndex={0}
        role="group"
        aria-label={`${label}. Use the left and right arrow keys to step through the days.`}
        data-testid="price-chart-surface"
        onKeyDown={onKey}
        onFocus={(e) => {
          // Keyboard focus shows the latest day; a click or tap picks its own day.
          if (e.currentTarget.matches(":focus-visible")) setHover(g.points.length - 1);
        }}
        onBlur={() => setHover(null)}
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerDown={(e) => onMove(e.clientX)}
        onPointerLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${BOX.width} ${BOX.height}`} className="block h-auto w-full" role="img" aria-label={label}>
          {g.yTicks.map((t) => (
            <g key={t.value}>
              <line x1={BOX.left} x2={BOX.width - BOX.right} y1={t.y} y2={t.y} className="stroke-line" strokeWidth={1} />
              <text x={BOX.left - 6} y={t.y + 3.5} textAnchor="end" className="fill-ink-faint font-mono" fontSize={10}>
                ${t.value.toLocaleString("en-CA")}
              </text>
            </g>
          ))}
          {g.xTicks.map((t) => (
            <text key={t.date} x={t.x} y={BOX.height - 8} textAnchor="middle" className="fill-ink-faint font-mono" fontSize={10}>
              {shortDate(t.date)}
            </text>
          ))}
          {g.path ? <path d={g.path} fill="none" className="stroke-sky" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}
          {g.points.length <= 40
            ? g.points.map((p, i) => (
                <circle key={p.snapshotDate} cx={p.x} cy={p.y} r={hover === i ? 5 : 3.5} className="fill-sky stroke-card" strokeWidth={2} />
              ))
            : null}
          {min && min !== last ? (
            <text x={min.x + dx(min.x)} y={min.y + 16} textAnchor={anchor(min.x)} className="fill-ink-soft font-mono" fontSize={11}>
              low {cad(min.priceCad)}
            </text>
          ) : null}
          {last ? (
            <>
              <circle cx={last.x} cy={last.y} r={5} className="fill-sky stroke-card" strokeWidth={2} />
              <text x={last.x + dx(last.x)} y={last.y - 9} textAnchor={anchor(last.x)} className="fill-ink font-mono" fontSize={11} fontWeight={600}>
                {cad(last.priceCad)}
              </text>
            </>
          ) : null}
          {shown ? <line x1={shown.x} x2={shown.x} y1={BOX.top} y2={BOX.height - BOX.bottom} className="stroke-ink-faint" strokeWidth={1} strokeDasharray="3 3" /> : null}
        </svg>
        {shown ? (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-line bg-card px-2 py-1 text-xs shadow-md"
            style={{ left: `${Math.min(88, Math.max(12, (shown.x / BOX.width) * 100))}%`, top: 0 }}
            data-testid="price-chart-tooltip"
          >
            <span className="font-mono font-semibold">{cad(shown.priceCad)}</span>
            <span className="text-ink-soft"> on {shortDate(shown.snapshotDate)}</span>
            {shown.airline ? <span className="block text-ink-faint">{[shown.airline, shown.stops === 0 ? "non-stop" : shown.stops != null ? `${shown.stops} stop${shown.stops === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}</span> : null}
          </div>
        ) : null}
      </div>
      <button type="button" onClick={() => setTable((v) => !v)} className="mt-1 text-xs font-medium text-sky hover:underline" aria-expanded={table}>
        {table ? "Hide table" : "Show as table"}
      </button>
      {table ? (
        <table className="mt-1 w-full text-left text-xs" data-testid="price-table">
          <caption className="sr-only">{label}</caption>
          <thead className="text-ink-faint">
            <tr>
              <th scope="col" className="py-0.5 pr-3 font-medium">Snapshot</th>
              <th scope="col" className="py-0.5 pr-3 font-medium">Lowest price</th>
              <th scope="col" className="py-0.5 font-medium">Airline</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {[...g.points].reverse().slice(0, 60).map((p) => (
              <tr key={p.snapshotDate}>
                <td className="py-0.5 pr-3">{shortDate(p.snapshotDate)}</td>
                <td className="py-0.5 pr-3">{cad(p.priceCad)}</td>
                <td className="py-0.5">{p.airline ?? "unknown"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
