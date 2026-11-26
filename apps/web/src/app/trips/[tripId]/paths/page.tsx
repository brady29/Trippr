"use client";

import { useParams } from "next/navigation";
import { Fragment, useState } from "react";
import { ModeIcon } from "@/components/icons";
import { BoardHeader, Flaps, RequireAuth } from "@/components/shell";
import { Button, ErrorNote, Spinner } from "@/components/ui";
import { usePath, useRoute, useTrip } from "@/lib/queries";

const fmt = (minutes: number | null | undefined) =>
  minutes == null ? "?" : minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60 ? `${minutes % 60} min` : ""}`.trim() : `${minutes} min`;

const MODE_WORD: Record<string, string> = { flight: "Flight", hsr: "High-speed train", train: "Train", road: "Road", boat: "Boat", maglev: "Maglev" };

/** A short inline field that reads as part of the sentence. */
const inline =
  "h-9 rounded-lg border border-line bg-card px-2.5 text-sm font-medium text-ink focus:border-ink-soft focus:outline-none";

function Paths({ tripId }: { tripId: string }) {
  const trip = useTrip(tripId);
  const current = trip.data?.routes.find((r) => r.isCurrent) ?? trip.data?.routes[0];
  const route = useRoute(current?.id ?? "");
  const cities = [...new Map((route.data?.stops ?? []).map((s) => [s.city.code, s.city.name])).entries()];

  const [from, setFrom] = useState("CKG");
  const [to, setTo] = useState("HKG");
  const [by, setBy] = useState("minutes");
  const [railOnly, setRailOnly] = useState(false);
  const [query, setQuery] = useState<{ from: string; to: string; by: string; railOnly: boolean } | null>(null);
  const path = usePath(query);
  const nameOf = (code: string) => cities.find(([c]) => c === code)?.[1];

  return (
    <>
      <BoardHeader eyebrow="Stored train and flight links" title="Find a path" width="max-w-3xl" />
      <main className="mx-auto max-w-3xl space-y-5 px-4 py-5 sm:px-6">
        <form
          className="rounded-2xl border border-line bg-card p-4 sm:p-5"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery({ from: from.trim().toUpperCase(), to: to.trim().toUpperCase(), by, railOnly });
          }}
        >
          <p className="flex flex-wrap items-center gap-x-2 gap-y-2.5 text-base">
            <label htmlFor="from">From</label>
            <input
              id="from"
              list="path-cities"
              value={from}
              maxLength={3}
              onChange={(e) => setFrom(e.target.value.toUpperCase())}
              className={`${inline} w-20 text-center font-mono uppercase`}
              aria-describedby="city-help"
            />
            <label htmlFor="to">to</label>
            <input
              id="to"
              list="path-cities"
              value={to}
              maxLength={3}
              onChange={(e) => setTo(e.target.value.toUpperCase())}
              className={`${inline} w-20 text-center font-mono uppercase`}
              aria-describedby="city-help"
            />
            <span aria-hidden>,</span>
            <label htmlFor="by" className="sr-only">
              Optimise for
            </label>
            <select id="by" value={by} onChange={(e) => setBy(e.target.value)} className={inline}>
              <option value="minutes">fastest</option>
              <option value="costCad">cheapest</option>
              <option value="hops">fewest changes</option>
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={railOnly} onChange={(e) => setRailOnly(e.target.checked)} className="h-4 w-4 accent-accent" />
              by train only
            </label>
          </p>
          <datalist id="path-cities">
            {cities.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </datalist>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary">
              Find a way
            </Button>
            <span id="city-help" className="text-xs text-ink-faint">
              Three-letter city codes{cities.length ? `, e.g. ${cities.slice(0, 3).map(([c, n]) => `${c} for ${n}`).join(", ")}` : ""}.
            </span>
          </div>
        </form>

        {path.isFetching ? <Spinner label="Searching the graph" /> : null}
        {path.error ? <ErrorNote error={path.error} /> : null}
        {path.data && !path.data.found ? (
          <div className="rounded-2xl border border-dashed border-line bg-card px-4 py-6 text-center">
            <p className="font-medium">
              No {path.data.railOnly ? "rail-only " : ""}way from {query?.from} to {query?.to} in the stored links
            </p>
            {path.data.railOnly ? <p className="mt-1 text-sm text-ink-soft">Try again without &ldquo;by train only&rdquo;.</p> : null}
          </div>
        ) : null}
        {path.data?.found ? (
          <section className="ticket overflow-hidden" aria-label="The way there">
            <div className="flex flex-wrap items-center justify-between gap-3 bg-board px-4 py-3 text-amber-soft sm:px-5">
              <div className="flex items-center gap-2 text-base">
                <Flaps text={query?.from ?? ""} />
                <span aria-hidden className="text-amber-soft/60">
                  →
                </span>
                <Flaps text={query?.to ?? ""} />
              </div>
              <dl className="flex gap-5 font-mono text-xs">
                <div>
                  <dt className="text-[10px] uppercase tracking-[0.16em] text-amber-soft/55">Time</dt>
                  <dd className="text-amber">{fmt(path.data.totalMinutes)}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-[0.16em] text-amber-soft/55">Cost</dt>
                  <dd className="text-amber">{path.data.totalCostCad != null ? `$${path.data.totalCostCad} CAD` : "unknown"}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-[0.16em] text-amber-soft/55">Changes</dt>
                  <dd className="text-amber">{Math.max(0, path.data.legs.length - 1)}</dd>
                </div>
              </dl>
            </div>
            {/* The journey, top to bottom: a stop, the leg out of it, the next stop. */}
            <ol className="px-4 py-4 sm:px-5">
              {path.data.legs.map((leg, i) => (
                <Fragment key={i}>
                  {i === 0 ? <Station code={leg.from} name={nameOf(leg.from)} /> : null}
                  <li className="ml-[13px] flex items-center gap-3 border-l-2 border-dashed border-line py-3 pl-5 text-sm">
                    <ModeIcon mode={leg.mode} className={`h-4 w-4 shrink-0 ${leg.mode === "flight" ? "text-sky" : "text-rail"}`} />
                    <span>{MODE_WORD[leg.mode] ?? leg.mode}</span>
                    <span className="font-mono text-xs text-ink-soft">{fmt(leg.minutes)}</span>
                    <span className="ml-auto truncate text-[11px] text-ink-faint">{leg.source}</span>
                  </li>
                  <Station code={leg.to} name={nameOf(leg.to)} />
                </Fragment>
              ))}
            </ol>
            <p className="border-t border-line px-4 py-2.5 text-xs text-ink-faint sm:px-5">
              Times come from stored links, each with a source and date. Links marked as an estimate need checking before booking.
            </p>
          </section>
        ) : null}
      </main>
    </>
  );
}

function Station({ code, name }: { code: string; name?: string }) {
  return (
    <li className="flex items-center gap-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 border-board bg-card">
        <span className="h-2 w-2 rounded-full bg-board" />
      </span>
      <span className="font-mono text-sm font-semibold">{code}</span>
      {name ? <span className="text-sm text-ink-soft">{name}</span> : null}
    </li>
  );
}

export default function PathsPage() {
  const { tripId } = useParams<{ tripId: string }>();
  return (
    <RequireAuth>
      <Paths tripId={tripId} />
    </RequireAuth>
  );
}
