"use client";

import type { ActivityFacets, LibraryActivity } from "@trippr/contracts";
import { Tag } from "./ui";

export const humanize = (category: string) => category.replace(/_/g, " ");

/** Where a catalogue place comes from: its category, rank, whether it is still listed, and each source with its licence. */
export function CatalogueFooter({ activity, facets }: { activity: LibraryActivity; facets: ActivityFacets | undefined }) {
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
