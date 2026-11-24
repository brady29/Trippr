"use client";

import type { LibraryActivity, SearchHit, SearchMatch, SearchRequest } from "@trippr/contracts";
import { useState, type ReactNode } from "react";
import { useSearch } from "@/lib/queries";
import { ActivityItem } from "./activity";
import { Button, ErrorNote, Input, Spinner, Tag } from "./ui";

const MATCH_LABEL: Record<SearchMatch, string> = {
  meaning: "Close in meaning",
  name: "Name matches",
  both: "Name and meaning",
  words: "Words match",
};

/** What the result says about itself: how it matched and, when the vectors ranked it, how close. */
function Reason({ hit }: { hit: SearchHit }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-soft" data-testid="search-reason" data-match={hit.match}>
      <Tag tone={hit.match === "meaning" || hit.match === "both" ? "amber" : "plain"}>{MATCH_LABEL[hit.match]}</Tag>
      <span>{hit.reason}</span>
      {hit.distanceKm != null ? <span>{hit.distanceKm} km away</span> : null}
    </div>
  );
}

/**
 * "Search by meaning": ask for what you want ("quiet viewpoints at sunset", "ramen near the hotel") and get places
 * ranked by meaning and name together, each with why it matched. Runs when you press Search (each question may use a
 * hosted call, so it does not fire as you type). Falls back to words, and says so, when meaning search is off.
 */
export function SemanticSearch({
  tripId,
  filters,
  canEdit,
  footerFor,
}: {
  tripId: string;
  /** The Activities page's current filters; they narrow the search too. */
  filters: { city?: string; tag?: string; category?: string };
  canEdit: boolean;
  /** The page's source and licence badges for a result. */
  footerFor: (activity: LibraryActivity) => ReactNode;
}) {
  const [text, setText] = useState("");
  const [asked, setAsked] = useState("");
  const request: SearchRequest | null = asked
    ? { q: asked, limit: 20, ...(filters.city ? { city: filters.city } : {}), ...(filters.tag ? { tag: filters.tag } : {}), ...(filters.category ? { category: filters.category } : {}) }
    : null;
  const result = useSearch(tripId, request);
  const data = result.data;

  return (
    <section className="space-y-2 rounded-xl border border-line bg-card p-3" data-testid="semantic-search" aria-label="Search by meaning">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setAsked(text.trim());
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Describe what you want: quiet viewpoint at sunset, cheap ramen, temples with gardens"
          aria-label="Search by meaning"
          maxLength={200}
        />
        <Button type="submit" variant="primary" disabled={!text.trim() || result.isFetching} data-testid="semantic-search-submit">
          Search
        </Button>
        {asked ? (
          <Button
            variant="ghost"
            onClick={() => {
              setAsked("");
              setText("");
            }}
          >
            Clear
          </Button>
        ) : null}
      </form>
      {asked && result.isFetching ? <Spinner label="Searching" /> : null}
      {result.error ? <ErrorNote error={result.error} /> : null}
      {data?.notice ? (
        <p className="rounded-lg bg-paper px-3 py-2 text-xs text-ink-soft" data-testid="search-notice" data-code={data.notice.code}>
          Matching words only. {data.notice.message}
        </p>
      ) : null}
      {data?.truncated ? <p className="text-xs text-ink-faint">Some places that fit your filters may be missing; try without a filter.</p> : null}
      {data && !data.hits.length && !result.isFetching ? <p className="text-sm text-ink-soft" data-testid="search-empty">Nothing matched “{data.query}”.</p> : null}
      {data?.hits.length ? (
        <>
          <p className="text-xs text-ink-faint" data-testid="search-count">
            {data.hits.length} result{data.hits.length === 1 ? "" : "s"} for “{data.query}”
            {data.mode === "hybrid" ? " by meaning and name" : " by words"}
          </p>
          <ul className="space-y-2" data-testid="search-results">
            {data.hits.map((hit) => (
              <ActivityItem
                key={hit.activity.id}
                activity={hit.activity}
                canVote={true}
                canEdit={canEdit}
                leading={
                  <span className="mt-0.5 w-11 shrink-0 rounded bg-board px-1 py-0.5 text-center font-mono text-[11px] font-semibold text-amber">
                    {hit.activity.cityCode}
                  </span>
                }
                footer={
                  <>
                    <Reason hit={hit} />
                    {footerFor(hit.activity)}
                  </>
                }
              />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
