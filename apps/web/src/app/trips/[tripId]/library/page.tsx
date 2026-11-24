"use client";

import { hasRole, type ActivityFacets, type ActivityPageQuery, type BestTime, type LibraryActivity, type PriceLevel } from "@trippr/contracts";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityItem, NewActivityForm } from "@/components/activity";
import { BoardHeader, BoardStat, RequireAuth, TopBar } from "@/components/shell";
import { TripNav } from "@/components/trip-nav";
import { Button, ErrorNote, Input, Select, Spinner, Tag } from "@/components/ui";
import { BEST_TIME_LABEL, PRICE_LABEL, durationMaxLabel } from "@/lib/enrichment";
import { useActivityFacets, useActivityPages, useLookupPlace, useTrip, useTripActivities } from "@/lib/queries";

/**
 * "Find places": looks up every activity that has no pin yet, one at a time
 * (the server keeps to OpenStreetMap's one-request-a-second limit).
 */
function FindPlaces({ activities }: { activities: LibraryActivity[] }) {
  const lookup = useLookupPlace();
  const [progress, setProgress] = useState<{ done: number; total: number; found: number } | null>(null);
  const stop = useRef(false);
  const todo = activities.filter((a) => (a.placeStatus ?? "unplaced") === "unplaced");
  const running = progress !== null && progress.done < progress.total;

  const run = async () => {
    stop.current = false;
    const list = [...todo];
    let found = 0;
    setProgress({ done: 0, total: list.length, found });
    for (let i = 0; i < list.length; i++) {
      if (stop.current) break;
      try {
        const r = await lookup.mutateAsync(list[i]!.id);
        if (r.outcome === "placed" || r.outcome === "check") found++;
      } catch {
        // Keep going; the activity stays unplaced.
      }
      setProgress({ done: i + 1, total: list.length, found });
    }
    setProgress((p) => (p ? { ...p, total: p.done } : p));
  };

  if (!todo.length && !progress) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-card p-3 text-sm" data-testid="find-places">
      {running ? (
        <>
          <Spinner label="Finding places" />
          <span>
            {progress.done} of {progress.total}, {progress.found} found
          </span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => (stop.current = true)}>
            Stop
          </Button>
        </>
      ) : progress ? (
        <span>
          Found {progress.found} of {progress.total}. {todo.length ? `${todo.length} still not on the map.` : "Everything has been looked up."}
        </span>
      ) : (
        <>
          <span>{todo.length} not on the map yet.</span>
          <Button size="sm" className="ml-auto" onClick={() => void run()}>
            Find places
          </Button>
        </>
      )}
    </div>
  );
}

/** A value that follows `value` after it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

const SCOPE_LABEL = { all: "Everything", mine: "Our ideas", catalogue: "From the catalogue" } as const;
const TOP_PICKS = [
  ["", "Any rank"],
  ["10", "Top 10 in each city"],
  ["25", "Top 25 in each city"],
  ["50", "Top 50 in each city"],
  ["100", "Top 100 in each city"],
] as const;

const humanize = (category: string) => category.replace(/_/g, " ");

/** Where a catalogue place comes from: its category, rank, whether it is still listed, and each source with its licence. */
function CatalogueFooter({ activity, facets }: { activity: LibraryActivity; facets: ActivityFacets | undefined }) {
  const names = new Map((facets?.sources ?? []).map((s) => [s.id, s.name]));
  const sources = activity.sources ?? [];
  if (!activity.catalogue && !sources.length && !activity.category) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-soft" data-testid="catalogue-info">
      {activity.catalogue ? (
        <span data-testid="catalogue-badge">
          <Tag tone="amber">From the catalogue</Tag>
        </span>
      ) : null}
      {activity.catalogue && activity.listed === false ? <Tag tone="dark">No longer listed</Tag> : null}
      {activity.category ? <span>{humanize(activity.category)}</span> : null}
      {activity.rank != null ? (
        <span title={activity.score != null ? `Score ${activity.score.toFixed(1)}` : undefined}>
          #{activity.rank} in {activity.cityName}
        </span>
      ) : null}
      {sources.length ? (
        <span className="text-ink-faint">
          Source: {[...new Set(sources.map((s) => names.get(s.source) ?? s.source))].join(", ")} ({[...new Set(sources.map((s) => s.licence))].join(", ")})
        </span>
      ) : null}
    </div>
  );
}

function Library({ tripId }: { tripId: string }) {
  const trip = useTrip(tripId);
  const own = useTripActivities(tripId); // the group's own ideas, for "Find places"
  const facets = useActivityFacets(tripId);
  const [scope, setScope] = useState<keyof typeof SCOPE_LABEL>("all");
  const [city, setCity] = useState("");
  const [tag, setTag] = useState("");
  const [category, setCategory] = useState("");
  const [source, setSource] = useState("");
  const [maxRank, setMaxRank] = useState("");
  const [fixedOnly, setFixedOnly] = useState(false);
  const [bestTime, setBestTime] = useState("");
  const [indoor, setIndoor] = useState("");
  const [durationMax, setDurationMax] = useState("");
  const [priceLevel, setPriceLevel] = useState("");
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 300);

  const filters = useMemo<ActivityPageQuery>(
    () => ({
      scope,
      ...(city ? { city } : {}),
      ...(tag ? { tag } : {}),
      ...(category ? { category } : {}),
      ...(source ? { source } : {}),
      ...(maxRank ? { maxRank: Number(maxRank) } : {}),
      ...(fixedOnly ? { fixedDates: true } : {}),
      ...(bestTime ? { bestTime: bestTime as BestTime } : {}),
      ...(indoor ? { indoor: indoor === "indoor" } : {}),
      ...(durationMax ? { durationMax: Number(durationMax) } : {}),
      ...(priceLevel ? { priceLevel: priceLevel as PriceLevel } : {}),
      ...(q ? { q } : {}),
    }),
    [scope, city, tag, category, source, maxRank, fixedOnly, bestTime, indoor, durationMax, priceLevel, q],
  );
  const pages = useActivityPages(tripId, filters);
  const shown = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const total = pages.data?.pages[0]?.total ?? 0;

  const f = facets.data;
  const cityName = f?.cities.find((c) => c.code === city)?.name ?? city;
  const canEdit = hasRole(trip.data?.role, "editor");
  const isOwner = trip.data?.role === "owner";
  const hasCatalogue = (f?.totals.catalogue ?? 0) > 0;
  const hasEnrichment = (f?.enrichment.enriched ?? 0) > 0;

  return (
    <>
      <BoardHeader
        eyebrow={`${trip.data?.trip.name ?? "Trip"} · activity library`}
        title="Activities"
        meta={
          <>
            <BoardStat label="Ideas" value={f?.totals.ideas ?? 0} />
            {hasCatalogue ? <BoardStat label="In the catalogue" value={f?.totals.catalogue ?? 0} /> : null}
            <BoardStat label="Cities" value={f?.totals.cities ?? 0} />
            <BoardStat label="Planned somewhere" value={f?.totals.planned ?? 0} />
            <BoardStat label="On the map" value={f?.totals.onMap ?? 0} />
          </>
        }
      />
      <main className="mx-auto grid grid-cols-1 max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[1fr_320px]">
        <section className="space-y-3">
          {isOwner ? <FindPlaces activities={own.data ?? []} /> : null}
          <div className="space-y-2" data-testid="library-filters">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search by name or address"
              aria-label="Search activities"
              type="search"
            />
            <div className="flex flex-wrap items-center gap-2">
              {hasCatalogue ? (
                <Select value={scope} onChange={(e) => setScope(e.target.value as keyof typeof SCOPE_LABEL)} aria-label="Show">
                  {Object.entries(SCOPE_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              ) : null}
              <Select value={city} onChange={(e) => setCity(e.target.value)} aria-label="Filter by city">
                <option value="">All cities</option>
                {(f?.cities ?? []).map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name} ({c.count})
                  </option>
                ))}
              </Select>
              <Select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag">
                <option value="">All tags</option>
                {(f?.tags ?? []).map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </Select>
              {hasCatalogue ? (
                <>
                  <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
                    <option value="">All categories</option>
                    {(f?.categories ?? []).map((c) => (
                      <option key={c.name} value={c.name}>
                        {humanize(c.name)} ({c.count})
                      </option>
                    ))}
                  </Select>
                  <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Filter by source">
                    <option value="">All sources</option>
                    {(f?.sources ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                  <Select value={maxRank} onChange={(e) => setMaxRank(e.target.value)} aria-label="Filter by rank">
                    {TOP_PICKS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </>
              ) : null}
              {hasEnrichment && f ? (
                <>
                  <Select value={bestTime} onChange={(e) => setBestTime(e.target.value)} aria-label="Filter by best time">
                    <option value="">Any time of day</option>
                    {f.enrichment.bestTimes
                      .filter((b) => b.name !== "any")
                      .map((b) => (
                        <option key={b.name} value={b.name}>
                          Best in the {BEST_TIME_LABEL[b.name].toLowerCase()}
                        </option>
                      ))}
                  </Select>
                  <Select value={indoor} onChange={(e) => setIndoor(e.target.value)} aria-label="Filter by indoor or outdoor">
                    <option value="">Indoor or outdoor</option>
                    <option value="indoor">Indoor ({f.enrichment.indoor})</option>
                    <option value="outdoor">Outdoor ({f.enrichment.outdoor})</option>
                  </Select>
                  <Select value={durationMax} onChange={(e) => setDurationMax(e.target.value)} aria-label="Filter by time needed">
                    <option value="">Any length</option>
                    {f.enrichment.durations.map((d) => (
                      <option key={d.max} value={d.max}>
                        {durationMaxLabel(d.max)} ({d.count})
                      </option>
                    ))}
                  </Select>
                  <Select value={priceLevel} onChange={(e) => setPriceLevel(e.target.value)} aria-label="Filter by price">
                    <option value="">Any price</option>
                    {f.enrichment.priceLevels.map((p) => (
                      <option key={p.name} value={p.name}>
                        {PRICE_LABEL[p.name]} ({p.count})
                      </option>
                    ))}
                  </Select>
                </>
              ) : null}
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <input type="checkbox" checked={fixedOnly} onChange={(e) => setFixedOnly(e.target.checked)} className="h-4 w-4" />
                Fixed dates only
              </label>
              <span className="ml-auto text-xs text-ink-faint" data-testid="result-count">
                {pages.isPending ? "" : `${shown.length} of ${total} shown`}
              </span>
            </div>
          </div>
          {pages.isPending ? <Spinner /> : null}
          {pages.error ? <ErrorNote error={pages.error} /> : null}
          {!pages.isPending && !shown.length ? <p className="text-sm text-ink-soft">Nothing matches those filters.</p> : null}
          <ul className="space-y-2" data-testid="activity-list">
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
                  <>
                    <CatalogueFooter activity={a} facets={f} />
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-ink-soft">
                      {a.plannedIn.length ? "Planned in" : "Not planned in any route"}
                      {a.plannedIn.map((p) => (
                        <Link key={`${p.routeId}-${p.stopId}`} href={`/routes/${p.routeId}`}>
                          <Tag tone="dark">{p.routeName}</Tag>
                        </Link>
                      ))}
                    </div>
                  </>
                }
              />
            ))}
          </ul>
          {pages.hasNextPage ? (
            <div className="flex justify-center">
              <Button data-testid="show-more" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
                {pages.isFetchingNextPage ? "Loading" : `Show ${Math.min(50, total - shown.length)} more`}
              </Button>
            </div>
          ) : null}
        </section>
        <aside>
          {canEdit && city ? (
            <NewActivityForm tripId={tripId} cityCode={city} cityName={cityName} />
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
