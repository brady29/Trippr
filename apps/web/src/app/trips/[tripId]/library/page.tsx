"use client";

import { hasRole, type ActivityPageQuery, type BestTime, type LibraryActivity, type PriceLevel } from "@trippr/contracts";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityItem, NewActivityForm } from "@/components/activity";
import { CatalogueFooter, humanize } from "@/components/catalogue-footer";
import { DownIcon } from "@/components/icons";
import { SemanticSearch } from "@/components/semantic-search";
import { BoardHeader, BoardStat, RequireAuth } from "@/components/shell";
import { Button, ErrorNote, Input, Select, Spinner, Tag } from "@/components/ui";
import { BEST_TIME_LABEL, PRICE_LABEL, durationMaxLabel } from "@/lib/enrichment";
import { useActivityFacets, useActivityPages, useLookupPlace, useTrip, useTripActivities } from "@/lib/queries";
import { routeHref } from "@/lib/routes";

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

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">{label}</legend>
      {children}
    </fieldset>
  );
}

function CityChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium ${
        active ? "border-board bg-board text-amber" : "border-line bg-card text-ink hover:border-ink-faint"
      }`}
    >
      {children}
    </button>
  );
}

/** Adding an idea needs a city: the form when one is picked, a pointer otherwise. */
function AddIdea({ canEdit, tripId, city, cityName }: { canEdit: boolean; tripId: string; city: string; cityName: string }) {
  if (!canEdit) return null;
  if (city) return <NewActivityForm tripId={tripId} cityCode={city} cityName={cityName} />;
  return (
    <p className="rounded-xl border border-dashed border-line p-3 text-sm text-ink-soft">
      Pick a city to add your own idea there, or add one from a stop in the route editor.
    </p>
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Everything beyond search and city, so phones can show how many are on behind the Filters button.
  const extraFilters = [tag, category, source, maxRank, bestTime, indoor, durationMax, priceLevel, fixedOnly ? "1" : ""].filter(Boolean).length;
  const anyFilter = extraFilters > 0 || Boolean(city) || Boolean(text) || scope !== "all";
  const clearAll = () => {
    setScope("all");
    setCity("");
    setTag("");
    setCategory("");
    setSource("");
    setMaxRank("");
    setFixedOnly(false);
    setBestTime("");
    setIndoor("");
    setDurationMax("");
    setPriceLevel("");
    setText("");
  };
  const topCities = [...(f?.cities ?? [])].sort((a, b) => b.count - a.count).slice(0, 10);
  const full = "w-full";

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
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* Filters: a rail on wide screens; on phones, search and city with the rest behind a button. */}
        <aside className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:self-start lg:overflow-y-auto lg:pb-1">
          <div className="space-y-3 rounded-2xl border border-line bg-card p-3.5" data-testid="library-filters">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search by name or address"
              aria-label="Search activities"
              type="search"
            />
            <FilterGroup label="Where">
              <Select value={city} onChange={(e) => setCity(e.target.value)} aria-label="Filter by city" className={full}>
                <option value="">All cities</option>
                {(f?.cities ?? []).map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name} ({c.count})
                  </option>
                ))}
              </Select>
            </FilterGroup>
            <button
              onClick={() => setFiltersOpen((o) => !o)}
              aria-expanded={filtersOpen}
              className="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2 text-sm font-medium lg:hidden"
            >
              <span>
                More filters{extraFilters ? <span className="ml-1.5 rounded-full bg-accent px-1.5 text-xs text-on-accent">{extraFilters}</span> : null}
              </span>
              <DownIcon className={`h-4 w-4 transition-transform ${filtersOpen ? "rotate-180" : ""}`} />
            </button>
            <div className={`space-y-3 ${filtersOpen ? "" : "hidden"} lg:block`}>
              {hasCatalogue ? (
                <FilterGroup label="Show">
                  <Select value={scope} onChange={(e) => setScope(e.target.value as keyof typeof SCOPE_LABEL)} aria-label="Show" className={full}>
                    {Object.entries(SCOPE_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </FilterGroup>
              ) : null}
              <FilterGroup label="What">
                <Select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag" className={full}>
                  <option value="">All tags</option>
                  {(f?.tags ?? []).map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </Select>
                {hasCatalogue ? (
                  <>
                    <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category" className={full}>
                      <option value="">All categories</option>
                      {(f?.categories ?? []).map((c) => (
                        <option key={c.name} value={c.name}>
                          {humanize(c.name)} ({c.count})
                        </option>
                      ))}
                    </Select>
                    <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Filter by source" className={full}>
                      <option value="">All sources</option>
                      {(f?.sources ?? []).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                    <Select value={maxRank} onChange={(e) => setMaxRank(e.target.value)} aria-label="Filter by rank" className={full}>
                      {TOP_PICKS.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  </>
                ) : null}
              </FilterGroup>
              <FilterGroup label="When and how">
                {hasEnrichment && f ? (
                  <>
                    <Select value={bestTime} onChange={(e) => setBestTime(e.target.value)} aria-label="Filter by best time" className={full}>
                      <option value="">Any time of day</option>
                      {f.enrichment.bestTimes
                        .filter((b) => b.name !== "any")
                        .map((b) => (
                          <option key={b.name} value={b.name}>
                            Best in the {BEST_TIME_LABEL[b.name].toLowerCase()}
                          </option>
                        ))}
                    </Select>
                    <Select value={indoor} onChange={(e) => setIndoor(e.target.value)} aria-label="Filter by indoor or outdoor" className={full}>
                      <option value="">Indoor or outdoor</option>
                      <option value="indoor">Indoor ({f.enrichment.indoor})</option>
                      <option value="outdoor">Outdoor ({f.enrichment.outdoor})</option>
                    </Select>
                    <Select value={durationMax} onChange={(e) => setDurationMax(e.target.value)} aria-label="Filter by time needed" className={full}>
                      <option value="">Any length</option>
                      {f.enrichment.durations.map((d) => (
                        <option key={d.max} value={d.max}>
                          {durationMaxLabel(d.max)} ({d.count})
                        </option>
                      ))}
                    </Select>
                    <Select value={priceLevel} onChange={(e) => setPriceLevel(e.target.value)} aria-label="Filter by price" className={full}>
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
                  <input type="checkbox" checked={fixedOnly} onChange={(e) => setFixedOnly(e.target.checked)} className="h-4 w-4 accent-accent" />
                  Fixed dates only
                </label>
              </FilterGroup>
            </div>
            {anyFilter ? (
              <button onClick={clearAll} className="text-xs font-medium text-sky hover:underline">
                Clear all filters
              </button>
            ) : null}
          </div>
          <AddIdea canEdit={canEdit} tripId={tripId} city={city} cityName={cityName} />
        </aside>

        <section className="min-w-0 space-y-3">
          {isOwner ? <FindPlaces activities={own.data ?? []} /> : null}
          {topCities.length > 1 ? (
            <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Quick city filter">
              <CityChip active={!city} onClick={() => setCity("")}>
                All cities
              </CityChip>
              {topCities.map((c) => (
                <CityChip key={c.code} active={city === c.code} onClick={() => setCity(city === c.code ? "" : c.code)}>
                  {c.name} <span className="font-mono opacity-70">{c.count}</span>
                </CityChip>
              ))}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{city ? `In ${cityName}` : "Everywhere on the trip"}</h2>
            <span className="text-xs text-ink-faint" data-testid="result-count">
              {pages.isPending ? "" : `${shown.length} of ${total} shown`}
            </span>
          </div>
          <SemanticSearch
            tripId={tripId}
            filters={{ city, tag, category }}
            canEdit={canEdit}
            footerFor={(a) => <CatalogueFooter activity={a} facets={f} />}
          />
          {pages.isPending ? <Spinner /> : null}
          {pages.error ? <ErrorNote error={pages.error} /> : null}
          {!pages.isPending && !shown.length ? (
            <div className="rounded-2xl border border-dashed border-line bg-card px-4 py-8 text-center">
              <p className="font-medium">Nothing matches those filters</p>
              {anyFilter ? (
                <button onClick={clearAll} className="mt-1 text-sm font-medium text-sky hover:underline">
                  Clear all filters
                </button>
              ) : null}
            </div>
          ) : null}
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
                        <Link key={`${p.routeId}-${p.stopId}`} href={routeHref(tripId, p.routeId)}>
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
      </main>
    </>
  );
}

export default function LibraryPage() {
  const { tripId } = useParams<{ tripId: string }>();
  return (
    <RequireAuth>
      <Library tripId={tripId} />
    </RequireAuth>
  );
}
