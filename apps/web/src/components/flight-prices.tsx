"use client";

import { SAMPLE_DATA_NOTE, type FlightPriceHistory, type TripFlightItem } from "@trippr/contracts";
import { dayDate, shortDate, type SignalConfidence, type SignalVerdict } from "@trippr/rules";
import { cad, useLegFlightPrices, useTripFlightPrices } from "@/lib/flights";
import { PriceChart } from "./price-chart";
import { ErrorNote, Spinner } from "./ui";

const VERDICT: Record<SignalVerdict, { label: string; style: string }> = {
  buy: { label: "Looks like a good time to book", style: "bg-ok/15 text-ok" },
  wait: { label: "Consider waiting", style: "bg-warn/15 text-warn" },
  watch: { label: "Keep watching", style: "bg-sky/15 text-sky" },
};
const CONFIDENCE: Record<SignalConfidence, string> = { low: "low confidence", medium: "medium confidence", high: "high confidence" };

const stopsText = (stops: number | null | undefined) =>
  stops == null ? null : stops === 0 ? "non-stop" : `${stops} stop${stops === 1 ? "" : "s"}`;

/** Shown wherever a flight price appears: these are not live fares. */
export function PriceDisclaimer({ text }: { text: string }) {
  return (
    <p className="text-[11px] text-ink-faint" data-testid="flight-price-disclaimer">
      {text}
    </p>
  );
}

function SampleBadge() {
  return (
    <p className="rounded-md bg-mark/20 px-2 py-1 text-[11px] font-medium text-ink" data-testid="flight-price-sample">
      {SAMPLE_DATA_NOTE}
    </p>
  );
}

function Body({ data }: { data: FlightPriceHistory }) {
  const { latest, signal, drop } = data;
  const group = latest?.priceCad != null ? latest.priceCad * data.travellers : null;
  const label = `Lowest price found for ${data.origin} to ${data.destination} on ${data.departDate ? shortDate(data.departDate) : "the planned date"}, by day`;
  return (
    <div className="space-y-2.5">
      {data.sample ? <SampleBadge /> : null}
      {latest ? (
        <p className="text-sm" data-testid="flight-price-latest">
          {latest.priceCad != null ? (
            <>
              <span className="font-mono text-base font-semibold">{cad(latest.priceCad)}</span>
              <span className="text-ink-soft"> per person</span>
              {data.travellers > 1 && group != null ? <span className="text-ink-soft"> · {cad(group)} for {data.travellers}</span> : null}
              <span className="block text-xs text-ink-faint">
                {[latest.airline, stopsText(latest.stops), `as of ${shortDate(latest.snapshotDate)}`].filter(Boolean).join(" · ")}
              </span>
            </>
          ) : (
            <span className="text-ink-soft">No price found for {data.departDate ? dayDate(data.departDate) : "this date"} on {shortDate(latest.snapshotDate)}.</span>
          )}
        </p>
      ) : null}

      {drop ? (
        <p className="rounded-md bg-ok/10 px-2 py-1 text-xs font-medium text-ok" data-testid="flight-price-drop">
          Price drop: {cad(drop.priceCad)} is {Math.round(drop.pct)}% below the previous low of {cad(drop.previousLowCad)} ({shortDate(drop.snapshotDate)}).
        </p>
      ) : null}

      {signal ? (
        <div className="space-y-1" data-testid="flight-signal" data-verdict={signal.verdict}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${VERDICT[signal.verdict].style}`}>{VERDICT[signal.verdict].label}</span>
            <span className="text-[11px] text-ink-faint">estimate · {CONFIDENCE[signal.confidence]}</span>
          </div>
          <p className="text-xs text-ink-soft">{signal.reason}</p>
        </div>
      ) : data.status === "past" ? (
        <p className="text-xs text-ink-soft">This flight has left, so there is no advice. The history is kept.</p>
      ) : null}

      <PriceChart points={data.points} label={label} />

      {latest?.cheapest ? (
        <p className="text-xs text-ink-soft" data-testid="flight-cheapest-day">
          {latest.cheapest.isPlanned ? (
            <>Your planned day is the cheapest of the days around it.</>
          ) : (
            <>
              Cheapest nearby day: <span className="font-medium text-ink">{dayDate(latest.cheapest.date)}</span> at{" "}
              <span className="font-mono">{cad(latest.cheapest.priceCad)}</span>
              {latest.cheapest.savingCad != null && latest.cheapest.savingCad > 0 ? ` (${cad(latest.cheapest.savingCad)} less per person)` : ""}.
            </>
          )}
        </p>
      ) : null}
      {latest && latest.window.length > 1 ? (
        <ul className="grid grid-cols-7 gap-1 text-center" aria-label="Prices on nearby dates">
          {latest.window.map((w) => {
            const planned = w.date === data.departDate;
            const best = latest.cheapest?.date === w.date;
            return (
              <li key={w.date} className={`rounded-md border px-0.5 py-1 ${planned ? "border-ink-soft bg-paper" : "border-line"}`} title={planned ? "Planned date" : undefined}>
                <span className="block text-[10px] text-ink-faint">{shortDate(w.date)}</span>
                <span className={`block font-mono text-[11px] ${best ? "font-semibold text-ok" : ""}`}>{w.priceCad != null ? cad(w.priceCad) : "none"}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <PriceDisclaimer text={data.disclaimer} />
    </div>
  );
}

/** Price history, booking signal and nearby-date prices for one flight leg. */
export function FlightPricePanel({ legId }: { legId: string }) {
  const q = useLegFlightPrices(legId, true);
  return (
    <div className="mt-1 w-full basis-full rounded-lg border border-line bg-card p-3" data-testid="flight-price-panel">
      {q.isPending ? (
        <Spinner />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : q.data.status === "off" ? (
        <p className="text-xs text-ink-soft">Flight price tracking is switched off.</p>
      ) : q.data.status === "not_flight" ? (
        <p className="text-xs text-ink-soft">Prices are tracked for flights between two airports.</p>
      ) : q.data.status === "no_data" ? (
        <div className="space-y-1.5">
          {q.data.sample ? <SampleBadge /> : null}
          <p className="text-xs text-ink-soft" data-testid="flight-price-empty">
            No prices yet for {q.data.origin} to {q.data.destination}. The first snapshot is taken by the next daily update.
          </p>
          <PriceDisclaimer text={q.data.disclaimer} />
        </div>
      ) : (
        <Body data={q.data} />
      )}
    </div>
  );
}

/** Price-drop notices for the trip's current route, shown at the top of the route page. */
export function FlightNotices({ tripId }: { tripId: string }) {
  const q = useTripFlightPrices(tripId);
  const notices = q.data?.notices ?? [];
  if (!q.data?.enabled || notices.length === 0) return null;
  return (
    <section className="rounded-xl border border-ok/40 bg-ok/10 px-3 py-2 text-sm" aria-label="Flight price drops" data-testid="flight-notices">
      <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ok">Flight price drops{q.data.sample ? " (sample data)" : ""}</h2>
      <ul className="mt-1 space-y-0.5">
        {notices.map((n: TripFlightItem) => (
          <li key={n.legId} data-testid="flight-notice">
            <span className="font-mono font-semibold">
              {n.origin} → {n.destination}
            </span>{" "}
            on {shortDate(n.departDate)} is now {cad(n.drop!.priceCad)}, {Math.round(n.drop!.pct)}% below its previous low of {cad(n.drop!.previousLowCad)}.
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-ink-soft">{q.data.disclaimer}</p>
    </section>
  );
}
