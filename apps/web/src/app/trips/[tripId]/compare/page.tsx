"use client";

import type { CompareResult, RouteSummary } from "@trippr/contracts";
import { shortDate } from "@trippr/rules";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { BoardHeader, RequireAuth, TopBar } from "@/components/shell";
import { TripNav } from "@/components/trip-nav";
import { ChecksBadge, ErrorNote, Panel, Select, Spinner } from "@/components/ui";
import { useCompare, useTrip } from "@/lib/queries";

function RouteHead({ route, side }: { route: RouteSummary; side: "A" | "B" }) {
  return (
    <div className="ticket p-4">
      <div className="flex items-center gap-2">
        <span className={`grid h-6 w-6 place-items-center rounded font-mono text-xs font-bold ${side === "A" ? "bg-board text-amber" : "bg-sky text-white"}`}>
          {side}
        </span>
        <Link href={`/routes/${route.id}`} className="truncate text-lg font-semibold hover:underline">
          {route.name}
        </Link>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-xs text-ink-soft">
        <span>{route.totalNights} nights</span>
        <span>home {shortDate(route.returnDate)}</span>
        <span>{route.stopCount} stops</span>
        <ChecksBadge level={route.checksLevel} />
      </div>
    </div>
  );
}

function CityList({ title, cities, tone }: { title: string; cities: string[]; tone: "shared" | "a" | "b" }) {
  const cls = tone === "shared" ? "bg-paper-2 text-ink" : tone === "a" ? "bg-board text-amber" : "bg-sky text-white";
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-ink-soft">
        {title} <span className="text-ink-faint">({cities.length})</span>
      </div>
      <div className="flex flex-wrap gap-1.5" data-testid={`compare-${tone}`}>
        {cities.length === 0 ? <span className="text-xs text-ink-faint">None</span> : null}
        {cities.map((c) => (
          <span key={c} className={`rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

function CompareView({ data }: { data: CompareResult }) {
  const max = Math.max(1, ...data.nightsByCountry.flatMap((n) => [n.a, n.b]));
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <RouteHead route={data.a} side="A" />
        <RouteHead route={data.b} side="B" />
      </div>
      <Panel title="Stops">
        <div className="space-y-4">
          <CityList title="In both" cities={data.shared} tone="shared" />
          <div className="grid gap-4 sm:grid-cols-2">
            <CityList title={`Only in ${data.a.name}`} cities={data.onlyA} tone="a" />
            <CityList title={`Only in ${data.b.name}`} cities={data.onlyB} tone="b" />
          </div>
        </div>
      </Panel>
      <Panel title="Nights per country">
        <ul className="space-y-3">
          {data.nightsByCountry.map((n) => (
            <li key={n.iso} className="grid grid-cols-[6.5rem_1fr] items-center gap-3 text-sm">
              <span className="truncate">{n.country}</span>
              <div className="space-y-1">
                {(["a", "b"] as const).map((side) => (
                  <div key={side} className="flex items-center gap-2">
                    <div className="h-3 flex-1 overflow-hidden rounded-full bg-paper-2">
                      <div
                        className={`h-full rounded-full ${side === "a" ? "bg-board" : "bg-sky"}`}
                        style={{ width: `${(n[side] / max) * 100}%` }}
                      />
                    </div>
                    <span className="w-6 text-right font-mono text-xs">{n[side]}</span>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </Panel>
      <div className="grid gap-4 sm:grid-cols-2">
        <Panel title={`Gained in ${data.b.name}`}>
          <ul className="space-y-1 text-sm">
            {data.activitiesGained.length === 0 ? <li className="text-ink-faint">Nothing new</li> : null}
            {data.activitiesGained.map((a) => (
              <li key={a.id} className="flex gap-2">
                <span className="text-ok">+</span>
                {a.title}
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={`Lost from ${data.a.name}`}>
          <ul className="space-y-1 text-sm">
            {data.activitiesLost.length === 0 ? <li className="text-ink-faint">Nothing lost</li> : null}
            {data.activitiesLost.map((a) => (
              <li key={a.id} className="flex gap-2">
                <span className="text-err">−</span>
                {a.title}
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function Compare({ tripId }: { tripId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const trip = useTrip(tripId);
  const routes = trip.data?.routes ?? [];
  const a = params.get("a") ?? routes.find((r) => r.isCurrent)?.id ?? routes[0]?.id ?? "";
  const b = params.get("b") ?? routes.find((r) => r.id !== a)?.id ?? "";
  const compare = useCompare(a, b);
  const pick = (side: "a" | "b", id: string) => {
    const next = new URLSearchParams({ a, b, [side]: id });
    router.replace(`/trips/${tripId}/compare?${next.toString()}`);
  };

  return (
    <>
      <BoardHeader eyebrow={`${trip.data?.trip.name ?? "Trip"} · compare`} title="Compare routes" />
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <div className="grid gap-2 sm:grid-cols-2">
          {(["a", "b"] as const).map((side) => (
            <Select key={side} value={side === "a" ? a : b} onChange={(e) => pick(side, e.target.value)} aria-label={`Route ${side.toUpperCase()}`}>
              {routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {side.toUpperCase()}: {r.name}
                </option>
              ))}
            </Select>
          ))}
        </div>
        {a === b && a ? <p className="text-sm text-ink-soft">Pick two different routes.</p> : null}
        {compare.isFetching && !compare.data ? <Spinner /> : null}
        {compare.error ? <ErrorNote error={compare.error} /> : null}
        {compare.data ? <CompareView data={compare.data} /> : null}
      </main>
    </>
  );
}

export default function ComparePage() {
  const { tripId } = useParams<{ tripId: string }>();
  const trip = useTrip(tripId);
  return (
    <>
      <TopBar>
        <TripNav tripId={tripId} tripName={trip.data?.trip.name} />
      </TopBar>
      <RequireAuth>
        <Suspense fallback={<Spinner />}>
          <Compare tripId={tripId} />
        </Suspense>
      </RequireAuth>
    </>
  );
}
