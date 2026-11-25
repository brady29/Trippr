"use client";

import type { StayCellsResponse } from "@trippr/contracts";
import { useMemo } from "react";
import { cadNight, cellsToFeatures, describeCell, legendRows, snapBbox, STAY_RAMP, type Bbox, type StayFeatureProps } from "@/lib/stay-cells";
import { useStayCells } from "@/lib/stay";
import { Button, ErrorNote, Spinner } from "./ui";

const GRADIENT = `linear-gradient(to right, ${STAY_RAMP.join(", ")})`;

/** The cells for the current viewport, as hexagons for the map and rows for the legend. */
export function useStayHeat(tripId: string, enabled: boolean, view: [[number, number], [number, number]] | null) {
  const bbox: Bbox | null = useMemo(() => (view ? snapBbox(view) : null), [view]);
  const query = useStayCells(tripId, bbox, enabled);
  const data: StayCellsResponse | undefined = enabled ? query.data : undefined;
  const features = useMemo(() => (data ? cellsToFeatures(data) : null), [data]);
  return { query, data, features, legend: useMemo(() => (data ? legendRows(data) : []), [data]) };
}

/** The "Stay prices" checkbox, next to the map's other layer toggles. */
export function StayToggle({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5" data-testid="stay-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-[#0f151d]" />
      <span aria-hidden className="inline-block h-2.5 w-6 rounded-sm border border-line" style={{ background: GRADIENT }} />
      <span>Stay prices</span>
    </label>
  );
}

/** What the colours mean: a gradient per the city's own price range, the snapshot dates and the Inside Airbnb credit. */
export function StayLegend({ heat, enabled }: { heat: ReturnType<typeof useStayHeat>; enabled: boolean }) {
  if (!enabled) return null;
  const { data, query, legend } = heat;
  const shown = data?.cells.filter((c) => c.price != null).length ?? 0;
  return (
    <section className="rounded-xl border border-line bg-card px-3 py-2 text-xs" aria-label="Stay prices legend" data-testid="stay-legend" data-cells={shown}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold uppercase tracking-[0.14em] text-ink-soft">Stay prices</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-ink-soft">cheaper</span>
          <span aria-hidden className="inline-block h-2.5 w-28 rounded-sm border border-line" style={{ background: GRADIENT }} />
          <span className="text-ink-soft">dearer</span>
        </span>
        {query.isFetching ? <Spinner label="Loading prices" /> : null}
      </div>
      {query.error ? <ErrorNote error={query.error} /> : null}
      {legend.length ? (
        <ul className="mt-1 space-y-0.5 text-ink-soft" aria-label="Price range by city">
          {legend.map((r) => (
            <li key={r.cityCode} data-testid="stay-legend-row" data-city={r.cityCode}>
              <span className="font-medium text-ink">{r.cityName}</span>: {cadNight(r.low)} to {cadNight(r.high)} a night, median per hexagon
              {r.snapshotDate ? ` (snapshot ${r.snapshotDate})` : ""}
            </li>
          ))}
        </ul>
      ) : data ? (
        <p className="mt-1 text-ink-soft" data-testid="stay-legend-empty">
          No stay prices in this view. Inside Airbnb publishes data for only a few cities, so most of the map has none. Zoom to a covered city.
        </p>
      ) : null}
      {data?.truncated ? (
        <p className="mt-1 text-ink-faint" data-testid="stay-legend-truncated">
          Showing the {data.cells.length.toLocaleString("en-CA")} busiest of {data.total.toLocaleString("en-CA")} hexagons. Zoom in to see the rest.
        </p>
      ) : null}
      <p className="mt-1 text-ink-faint">
        Hexagons are about 1 km across and need 3 or more listings. Asking prices in CAD, not quotes; colours compare areas within a city, not between cities.
      </p>
      {data?.attribution ? (
        <p className="mt-0.5 text-ink-faint" data-testid="stay-legend-attribution">
          {data.attribution}
        </p>
      ) : null}
    </section>
  );
}

/** The cell a click landed on. */
export function StayCellCard({ cell, cityName, onClose }: { cell: StayFeatureProps; cityName?: string; onClose(): void }) {
  return (
    <section className="rounded-2xl border border-line bg-card p-3 text-sm" data-testid="stay-cell-card" aria-label="Stay prices here">
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-1 inline-block h-3 w-3 shrink-0 rounded-sm border border-line" style={{ background: GRADIENT }} />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold leading-snug">Stay prices{cityName ? ` · ${cityName}` : ""}</h2>
          <p className="text-ink-soft">{describeCell({ price: cell.price, pp: cell.pp, listings: cell.listings })}.</p>
          <p className="mt-1 text-xs text-ink-faint">One hexagon of about 1 km across. Individual listings are never shown.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close stay prices details">
          Close
        </Button>
      </div>
    </section>
  );
}
