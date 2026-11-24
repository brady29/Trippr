import type { Activity } from "@trippr/contracts";
import { aiLabelFor, enrichmentBadges, genericSubtitle, provenanceNote } from "@/lib/enrichment";

/**
 * What the enrichment stage (an LLM, run by the data pipeline) added to an activity. It is always marked as AI:
 * the summary carries the pipeline's own sentence ("Summary written by AI from Wikidata and Wikivoyage"), and the
 * badges are estimates. A hand-written activity or a place the stage skipped shows none of this.
 */

/** A readable name for a place whose own name is formal or generic. Under the title, never instead of it. */
export function GenericNameSubtitle({ activity }: { activity: Activity }) {
  const name = genericSubtitle(activity.title, activity.enrichment);
  if (!name) return null;
  return (
    <div className="text-xs text-ink-soft" data-testid="generic-subtitle" title="A readable name suggested by AI">
      {name}
    </div>
  );
}

/** Duration, best time and indoor badges, then the summary with its AI label. */
export function EnrichmentBlock({ activity }: { activity: Activity }) {
  const e = activity.enrichment;
  if (!e) return null;
  const badges = enrichmentBadges(e);
  const label = aiLabelFor(e);
  if (!badges.length && !e.summary) return null;
  return (
    <div className="mt-1.5 space-y-1" data-testid="enrichment">
      {badges.length ? (
        <ul className="flex flex-wrap items-center gap-1" aria-label="Estimates" data-testid="enrichment-badges">
          {badges.map((b) => (
            <li
              key={b.key}
              data-testid={`badge-${b.key}`}
              title={b.title}
              className="inline-flex items-center rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-soft"
            >
              {b.label}
            </li>
          ))}
        </ul>
      ) : null}
      {e.summary ? (
        <div>
          <p className="text-sm leading-snug text-ink" data-testid="ai-summary">
            {e.summary}
          </p>
          {label ? (
            <p className="mt-0.5 text-[11px] text-ink-faint" data-testid="ai-label" title={provenanceNote(e)}>
              {label}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
