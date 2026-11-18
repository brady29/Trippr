"use client";

import { hasRole } from "@trippr/contracts";
import { isFixedDate } from "@trippr/rules";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ActivityItem, NewActivityForm } from "@/components/activity";
import { BoardHeader, BoardStat, RequireAuth, TopBar } from "@/components/shell";
import { TripNav } from "@/components/trip-nav";
import { ErrorNote, Select, Spinner, Tag } from "@/components/ui";
import { useTrip, useTripActivities } from "@/lib/queries";

function Library({ tripId }: { tripId: string }) {
  const trip = useTrip(tripId);
  const activities = useTripActivities(tripId);
  const [city, setCity] = useState("");
  const [tag, setTag] = useState("");
  const [fixedOnly, setFixedOnly] = useState(false);

  const all = useMemo(() => activities.data ?? [], [activities.data]);
  const cities = useMemo(
    () => [...new Map(all.map((a) => [a.cityCode, a.cityName])).entries()].sort((a, b) => a[1].localeCompare(b[1])),
    [all],
  );
  const tags = useMemo(() => [...new Set(all.flatMap((a) => a.tags))].sort(), [all]);
  const shown = all.filter(
    (a) => (!city || a.cityCode === city) && (!tag || a.tags.includes(tag)) && (!fixedOnly || isFixedDate(a.when)),
  );
  const canEdit = hasRole(trip.data?.role, "editor");

  return (
    <>
      <BoardHeader
        eyebrow={`${trip.data?.trip.name ?? "Trip"} · activity library`}
        title="Activities"
        meta={
          <>
            <BoardStat label="Ideas" value={all.length} />
            <BoardStat label="Cities" value={cities.length} />
            <BoardStat label="Planned somewhere" value={all.filter((a) => a.plannedIn.length).length} />
          </>
        }
      />
      <main className="mx-auto grid grid-cols-1 max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[1fr_320px]">
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={city} onChange={(e) => setCity(e.target.value)} aria-label="Filter by city">
              <option value="">All cities</option>
              {cities.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </Select>
            <Select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag">
              <option value="">All tags</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input type="checkbox" checked={fixedOnly} onChange={(e) => setFixedOnly(e.target.checked)} className="h-4 w-4" />
              Fixed dates only
            </label>
            <span className="ml-auto text-xs text-ink-faint">{shown.length} shown</span>
          </div>
          {activities.isPending ? <Spinner /> : null}
          {activities.error ? <ErrorNote error={activities.error} /> : null}
          <ul className="space-y-2">
            {shown.map((a) => (
              <ActivityItem
                key={a.id}
                activity={a}
                canVote={true}
                canEdit={canEdit}
                leading={
                  <span className="mt-0.5 w-11 shrink-0 rounded bg-board px-1 py-0.5 text-center font-mono text-[11px] font-semibold text-amber">
                    {a.cityCode}
                  </span>
                }
                footer={
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-ink-soft">
                    {a.plannedIn.length ? "Planned in" : "Not planned in any route"}
                    {a.plannedIn.map((p) => (
                      <Link key={`${p.routeId}-${p.stopId}`} href={`/routes/${p.routeId}`}>
                        <Tag tone="dark">{p.routeName}</Tag>
                      </Link>
                    ))}
                  </div>
                }
              />
            ))}
          </ul>
        </section>
        <aside>
          {canEdit && city ? (
            <NewActivityForm tripId={tripId} cityCode={city} cityName={cities.find(([c]) => c === city)?.[1] ?? city} />
          ) : canEdit ? (
            <p className="rounded-xl border border-dashed border-line p-3 text-sm text-ink-soft">
              Pick a city to add an activity there, or add one from a stop in the route editor.
            </p>
          ) : null}
        </aside>
      </main>
    </>
  );
}

export default function LibraryPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const trip = useTrip(tripId);
  return (
    <>
      <TopBar>
        <TripNav tripId={tripId} tripName={trip.data?.trip.name} />
      </TopBar>
      <RequireAuth>
        <Library tripId={tripId} />
      </RequireAuth>
    </>
  );
}
