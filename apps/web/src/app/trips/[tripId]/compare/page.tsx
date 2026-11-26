"use client";

import type { CompareResult } from "@trippr/contracts";
import { shortDate } from "@trippr/rules";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { BoardHeader, RequireAuth } from "@/components/shell";
import { cad } from "@/components/budget-panel";
import { ChecksBadge, ErrorNote, Panel, Select, Spinner } from "@/components/ui";
import { LineMap } from "@/components/line-map";
import { useCompare, useRoute, useTrip } from "@/lib/queries";
import { routeHref } from "@/lib/routes";

function SideBadge({ side }: { side: "A" | "B" }) {
  return (
    <span className={`inline-grid h-6 w-6 shrink-0 place-items-center rounded font-mono text-xs font-bold ${side === "A" ? "bg-board text-amber" : "bg-sky text-white"}`}>
      {side}
    </span>
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

/** B against A: "+$120", "−3", or nothing when they match. */
function delta(a: number, b: number, money = false) {
  const d = Math.round(b - a);
  if (d === 0) return null;
  const abs = money ? cad(Math.abs(d)) : String(Math.abs(d));
  return `${d > 0 ? "+" : "−"}${abs}`;
}

function CompareView({ data }: { data: CompareResult }) {
  const max = Math.max(1, ...data.nightsByCountry.flatMap((n) => [n.a, n.b]));
  const rows: { label: string; a: string; b: string; diff: string | null; total?: boolean }[] = [
    { label: "Nights", a: String(data.a.totalNights), b: String(data.b.totalNights), diff: delta(data.a.totalNights, data.b.totalNights) },
    { label: "Stops", a: String(data.a.stopCount), b: String(data.b.stopCount), diff: delta(data.a.stopCount, data.b.stopCount) },
    { label: "Home", a: shortDate(data.a.returnDate), b: shortDate(data.b.returnDate), diff: null },
    ...(
      [
        ["Stays", "stay"],
        ["Getting around", "travel"],
        ["Planned activities", "activities"],
        ["Total per person", "total"],
      ] as const
    ).map(([label, key]) => ({
      label,
      a: cad(data.budget.a.perPerson[key]),
      b: cad(data.budget.b.perPerson[key]),
      diff: delta(data.budget.a.perPerson[key], data.budget.b.perPerson[key], true),
      total: key === "total",
    })),
  ];
  return (
    <div className="space-y-5">
      <section className="overflow-x-auto rounded-2xl border border-line bg-card" aria-label="The two routes in numbers">
        <table className="w-full min-w-[30rem] text-sm" data-testid="compare-budget">
          <thead>
            <tr className="border-b border-line text-left">
              <th scope="col" className="px-4 py-2.5 text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">
                <span className="sr-only">Measure</span>
              </th>
              <th scope="col" className="px-4 py-2.5 text-right">
                <SideBadge side="A" /> <span className="ml-1 font-semibold">{data.a.name}</span>
              </th>
              <th scope="col" className="px-4 py-2.5 text-right">
                <SideBadge side="B" /> <span className="ml-1 font-semibold">{data.b.name}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={r.total ? "border-t border-line font-semibold" : ""}>
                <th scope="row" className="px-4 py-2 text-left font-normal text-ink-soft">
                  {r.label}
                </th>
                <td className="px-4 py-2 text-right font-mono">{r.a}</td>
                <td className="px-4 py-2 text-right font-mono">
                  {r.b}
                  {r.diff ? <span className="ml-2 text-xs font-normal text-ink-soft">{r.diff}</span> : null}
                </td>
              </tr>
            ))}
            <tr className="border-t border-line">
              <th scope="row" className="px-4 py-2 text-left font-normal text-ink-soft">
                Checks
              </th>
              <td className="px-4 py-2 text-right">
                <ChecksBadge level={data.a.checksLevel} />
              </td>
              <td className="px-4 py-2 text-right">
                <ChecksBadge level={data.b.checksLevel} />
              </td>
            </tr>
          </tbody>
        </table>
        {data.budget.a.missing.stayNights + data.budget.a.missing.travelLegs + data.budget.b.missing.stayNights + data.budget.b.missing.travelLegs > 0 ? (
          <p className="border-t border-line px-4 py-2 text-xs text-ink-faint">
            Costs in CAD. Stays or legs without an estimate count as $0; fill them in on each route&apos;s stop cards.
          </p>
        ) : null}
      </section>

      <Panel title="Stops">
        <div className="grid gap-4 sm:grid-cols-3">
          <CityList title={`Only in ${data.a.name}`} cities={data.onlyA} tone="a" />
          <CityList title="In both" cities={data.shared} tone="shared" />
          <CityList title={`Only in ${data.b.name}`} cities={data.onlyB} tone="b" />
        </div>
      </Panel>
      <Panel
        title="Nights per country"
        action={
          <span className="flex items-center gap-3 text-[11px] text-ink-soft">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-3 rounded-full bg-board" /> A
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-3 rounded-full bg-sky" /> B
            </span>
          </span>
        }
      >
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
  const viewA = useRoute(a);
  const viewB = useRoute(b);
  const pick = (side: "a" | "b", id: string) => {
    const next = new URLSearchParams({ a, b, [side]: id });
    router.replace(`/trips/${tripId}/compare?${next.toString()}`);
  };

  const byId = new Map(routes.map((r) => [r.id, r]));
  return (
    <>
      <BoardHeader eyebrow={`${trip.data?.trip.name ?? "Trip"} · compare`} title="Compare routes" width="max-w-5xl" />
      <main className="mx-auto max-w-5xl space-y-5 px-4 py-5 sm:px-6">
        {/* Each side picks its route; swap flips them. */}
        <div className="grid items-stretch gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          {(["a", "b"] as const).map((side, i) => {
            const id = side === "a" ? a : b;
            const r = byId.get(id);
            const card = (
              <div key={side} className="ticket flex flex-col gap-2 p-4">
                <div className="flex items-center gap-2">
                  <SideBadge side={side === "a" ? "A" : "B"} />
                  <Select value={id} onChange={(e) => pick(side, e.target.value)} aria-label={`Route ${side.toUpperCase()}`} className="h-9 min-w-0 flex-1 font-semibold">
                    {routes.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                        {x.isCurrent ? " (current)" : ""}
                      </option>
                    ))}
                  </Select>
                </div>
                {r ? (
                  <>
                    <p className="line-clamp-2 text-xs text-ink-soft">{r.cities.join(" → ")}</p>
                    <Link href={routeHref(tripId, r.id)} className="mt-auto text-xs font-medium text-sky hover:underline">
                      Open {r.name}
                    </Link>
                  </>
                ) : null}
              </div>
            );
            return i === 0 ? (
              [
                card,
                <button
                  key="swap"
                  onClick={() => router.replace(`/trips/${tripId}/compare?${new URLSearchParams({ a: b, b: a }).toString()}`)}
                  className="grid h-9 w-9 place-self-center rounded-full border border-line bg-card text-ink-soft hover:border-ink-faint hover:text-ink"
                  aria-label="Swap A and B"
                  title="Swap A and B"
                >
                  ⇄
                </button>,
              ]
            ) : (
              card
            );
          })}
        </div>
        {a === b && a ? <p className="text-sm text-ink-soft">Pick two different routes.</p> : null}
        {compare.isFetching && !compare.data ? <Spinner /> : null}
        {compare.error ? <ErrorNote error={compare.error} /> : null}
        {viewA.data && viewB.data && a !== b ? (
          <section className="rounded-2xl border border-line bg-card p-4" aria-label="Both routes on one line map" data-testid="compare-line-map">
            <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft">
              <span className="font-semibold text-ink">Both routes, one map</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-1.5 w-6 rounded-full bg-ink" /> A · {viewA.data.route.name}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2 w-6 rounded-full bg-mark" /> B · {viewB.data.route.name}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-3 w-4 rounded-full border-2 border-ink bg-card" /> on both
              </span>
            </div>
            <LineMap
              lines={[
                { stops: viewA.data.stops, color: "var(--color-ink)", name: `A, ${viewA.data.route.name}` },
                { stops: viewB.data.stops, color: "var(--color-mark)", name: `B, ${viewB.data.route.name}` },
              ]}
              width={640}
              height={380}
              playKey={`${a}-${b}`}
              label="Both routes"
            />
          </section>
        ) : null}
        {compare.data ? <CompareView data={compare.data} /> : null}
      </main>
    </>
  );
}

export default function ComparePage() {
  const { tripId } = useParams<{ tripId: string }>();
  return (
    <RequireAuth>
      <Suspense fallback={<Spinner />}>
        <Compare tripId={tripId} />
      </Suspense>
    </RequireAuth>
  );
}
