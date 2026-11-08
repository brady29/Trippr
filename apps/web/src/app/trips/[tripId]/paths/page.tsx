"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { ModeIcon } from "@/components/icons";
import { BoardHeader, RequireAuth, TopBar } from "@/components/shell";
import { TripNav } from "@/components/trip-nav";
import { Button, ErrorNote, Input, Label, Panel, Select, Spinner } from "@/components/ui";
import { usePath, useTrip } from "@/lib/queries";

const fmt = (minutes: number | null | undefined) =>
  minutes == null ? "?" : minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60 ? `${minutes % 60} min` : ""}`.trim() : `${minutes} min`;

function Paths() {
  const [from, setFrom] = useState("CKG");
  const [to, setTo] = useState("HKG");
  const [by, setBy] = useState("minutes");
  const [railOnly, setRailOnly] = useState(false);
  const [query, setQuery] = useState<{ from: string; to: string; by: string; railOnly: boolean } | null>(null);
  const path = usePath(query);

  return (
    <>
      <BoardHeader eyebrow="Stored train and flight links" title="Pathfinding" />
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <form
          className="grid gap-3 rounded-2xl border border-line bg-card p-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery({ from: from.trim().toUpperCase(), to: to.trim().toUpperCase(), by, railOnly });
          }}
        >
          <div>
            <Label htmlFor="from">From (city code)</Label>
            <Input id="from" value={from} maxLength={3} onChange={(e) => setFrom(e.target.value)} className="font-mono uppercase" />
          </div>
          <div>
            <Label htmlFor="to">To (city code)</Label>
            <Input id="to" value={to} maxLength={3} onChange={(e) => setTo(e.target.value)} className="font-mono uppercase" />
          </div>
          <div>
            <Label htmlFor="by">Optimise for</Label>
            <Select id="by" value={by} onChange={(e) => setBy(e.target.value)} className="w-full">
              <option value="minutes">Fastest</option>
              <option value="costCad">Cheapest</option>
              <option value="hops">Fewest changes</option>
            </Select>
          </div>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input type="checkbox" checked={railOnly} onChange={(e) => setRailOnly(e.target.checked)} className="h-4 w-4" />
            Trains only (is there a train at all?)
          </label>
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary">
              Find a way
            </Button>
          </div>
        </form>

        {path.isFetching ? <Spinner label="Searching the graph" /> : null}
        {path.error ? <ErrorNote error={path.error} /> : null}
        {path.data && !path.data.found ? (
          <Panel title="Result">
            <p className="text-sm">
              No {path.data.railOnly ? "rail-only " : ""}route between {query?.from} and {query?.to} in the stored links.
            </p>
          </Panel>
        ) : null}
        {path.data?.found ? (
          <Panel
            title="Result"
            action={
              <span className="font-mono text-xs text-ink-soft">
                {fmt(path.data.totalMinutes)} · {path.data.totalCostCad != null ? `$${path.data.totalCostCad} CAD` : "cost unknown"}
              </span>
            }
          >
            <ol className="space-y-2">
              {path.data.legs.map((leg, i) => (
                <li key={i} className="flex items-center gap-3 rounded-lg bg-paper px-3 py-2 text-sm">
                  <ModeIcon mode={leg.mode} className={leg.mode === "flight" ? "text-sky" : "text-rail"} />
                  <span className="font-mono font-semibold">
                    {leg.from} → {leg.to}
                  </span>
                  <span className="text-ink-soft">{leg.mode}</span>
                  <span className="ml-auto font-mono text-xs">{fmt(leg.minutes)}</span>
                  <span className="hidden text-[11px] text-ink-faint sm:inline">{leg.source}</span>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-ink-faint">
              Times are stored on LINK edges with a source and date; &ldquo;estimate&rdquo; links need checking before booking.
            </p>
          </Panel>
        ) : null}
      </main>
    </>
  );
}

export default function PathsPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const trip = useTrip(tripId);
  return (
    <>
      <TopBar>
        <TripNav tripId={tripId} tripName={trip.data?.trip.name} />
      </TopBar>
      <RequireAuth>
        <Paths />
      </RequireAuth>
    </>
  );
}
