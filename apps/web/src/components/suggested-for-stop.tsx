"use client";

import type { Suggestion, SuggestionsRequest, SuggestionsResponse } from "@trippr/contracts";
import { useState } from "react";
import { BEST_TIME_LABEL } from "@/lib/enrichment";
import { useActivityFacets, usePlanToggle, useSuggestions, useVote } from "@/lib/queries";
import { ActivityItem } from "./activity";
import { CatalogueFooter } from "./catalogue-footer";
import { Button, ErrorNote, Select, Spinner, Tag } from "./ui";

const BASIS_NOTE: Record<SuggestionsResponse["basis"], string> = {
  group_taste: "Matched to the places your group voted for, planned or commented on here.",
  tag_preferences: "Following the city's ranking and the kinds of places your group liked.",
  catalogue_rank: "Following the city's ranking.",
};

/** The one line that says why: the liked place it resembles, or the fact it rests on. Written by rules, not a model. */
function ReasonLine({ suggestion }: { suggestion: Suggestion }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink" data-testid="suggestion-reason" data-because={suggestion.because}>
      <span className="font-medium">{suggestion.reason}</span>
      {suggestion.closeness ? (
        <span title="How close in meaning the two places are">
          <Tag tone="amber">{suggestion.closeness}</Tag>
        </span>
      ) : null}
    </div>
  );
}

/**
 * "Suggested for this stop": places in the stop's city the group is likely to like next, from its own votes and plans, each with
 * the reason. Nothing here calls a model, so it loads with the drawer. "Add to ideas" is an up-vote (the place joins the
 * city's shared list, and leaves these suggestions); "Plan here" is the drawer's own planning toggle.
 */
export function SuggestedForStop({
  tripId,
  routeId,
  stopId,
  cityName,
  canEdit,
  canVote,
}: {
  tripId: string;
  routeId: string;
  stopId: string;
  cityName: string;
  canEdit: boolean;
  canVote: boolean;
}) {
  const [bestTime, setBestTime] = useState("");
  const [indoor, setIndoor] = useState("");
  const request: SuggestionsRequest = { limit: 6, ...(bestTime ? { bestTime } : {}), ...(indoor ? { indoor: indoor === "indoor" } : {}) };
  const result = useSuggestions(tripId, stopId, request);
  const facets = useActivityFacets(tripId);
  const vote = useVote();
  const plan = usePlanToggle(routeId);
  const data = result.data;
  const filtered = Boolean(bestTime || indoor);

  return (
    <section className="space-y-2 rounded-xl border border-line bg-card p-3" data-testid="suggestions" aria-label="Suggested for this stop">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Suggested for this stop</h3>
        <div className="ml-auto flex gap-1.5">
          <Select value={bestTime} onChange={(e) => setBestTime(e.target.value)} aria-label="Suggestions: time of day" className="h-8 text-xs">
            <option value="">Any time</option>
            {(["morning", "afternoon", "evening", "night"] as const).map((t) => (
              <option key={t} value={t}>
                Best in the {BEST_TIME_LABEL[t].toLowerCase()}
              </option>
            ))}
          </Select>
          <Select value={indoor} onChange={(e) => setIndoor(e.target.value)} aria-label="Suggestions: indoor or outdoor" className="h-8 text-xs">
            <option value="">In or out</option>
            <option value="indoor">Indoor</option>
            <option value="outdoor">Outdoor</option>
          </Select>
        </div>
      </div>
      {result.isPending ? <Spinner label="Finding suggestions" /> : null}
      {result.error ? (
        <div className="space-y-2" data-testid="suggestions-error">
          <ErrorNote error={result.error} />
          <Button size="sm" onClick={() => void result.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}
      {data ? (
        <>
          {data.notice ? (
            <p className="rounded-lg bg-paper px-3 py-2 text-xs text-ink-soft" data-testid="suggestions-notice" data-code={data.notice.code}>
              {data.notice.message}
            </p>
          ) : (
            <p className="text-xs text-ink-faint" data-testid="suggestions-basis" data-basis={data.basis}>
              {BASIS_NOTE[data.basis]}
            </p>
          )}
          {!data.suggestions.length && !data.notice ? (
            <p className="text-sm text-ink-soft" data-testid="suggestions-empty">
              {filtered ? `No place in ${cityName} fits those filters.` : `Nothing to suggest in ${cityName} yet.`}
            </p>
          ) : null}
          <ul className="space-y-2" data-testid="suggestions-list">
            {data.suggestions.map((s) => (
              <ActivityItem
                key={s.activity.id}
                activity={s.activity}
                canVote={canVote}
                canEdit={false}
                footer={
                  <>
                    <ReasonLine suggestion={s} />
                    <CatalogueFooter activity={s.activity} facets={facets.data} />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!canVote || vote.isPending}
                        onClick={() => vote.mutate({ activityId: s.activity.id, value: 1 })}
                        aria-label={`Add ${s.activity.title} to ideas`}
                        title="Adds it to the group's ideas for this city with your vote"
                      >
                        Add to ideas
                      </Button>
                      {canEdit ? (
                        <Button
                          size="sm"
                          disabled={plan.isPending}
                          onClick={() => plan.mutate({ stopId, activityId: s.activity.id, planned: true, title: s.activity.title })}
                          aria-label={`Plan ${s.activity.title} at this stop`}
                        >
                          Plan here
                        </Button>
                      ) : null}
                    </div>
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
