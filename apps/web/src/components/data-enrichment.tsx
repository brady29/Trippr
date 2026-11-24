import type { DataLoadView } from "@trippr/contracts";
import { coverage, evalRows } from "@/lib/enrichment";
import { Panel } from "./ui";

/** What the AI enrichment stage did for the latest bundle: coverage, model, date and its eval scores. */
export function EnrichmentStats({ load }: { load: DataLoadView }) {
  const e = load.enrichment;
  const scores = evalRows(load.evals);
  return (
    <Panel title="AI enrichment">
      {e ? (
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-4" data-testid="enrichment-stats">
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-faint">Places enriched</dt>
            <dd data-testid="enrichment-places">{coverage(e, load.counts.places)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-faint">With an AI summary</dt>
            <dd data-testid="enrichment-summaries">{e.withSummary.toLocaleString("en-CA")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-faint">Model</dt>
            <dd data-testid="enrichment-model">
              {e.models.join(", ") || "unknown"}
              {e.promptVersions.length ? <span className="text-ink-faint"> · prompt {e.promptVersions.join(", ")}</span> : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-faint">Enriched on</dt>
            <dd data-testid="enrichment-date">{e.enrichedAt ? e.enrichedAt.slice(0, 10) : e.sourceDate}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-ink-soft" data-testid="enrichment-none">
          This bundle has no AI enrichment, so places show without summaries, durations or best times.
        </p>
      )}
      <p className="mt-3 text-sm text-ink-soft">
        A language model writes a one-line summary, a typical visit time, the best time of day and whether a place is indoors, from the
        place&apos;s own record only. The app labels every summary as written by AI.
      </p>
      {e ? (
        scores ? (
          <div className="mt-3" data-testid="enrichment-eval">
            <div className="text-xs uppercase tracking-wide text-ink-faint">
              Scores on the labelled places
              {scores.eval.metrics.n != null ? ` (${scores.eval.metrics.n})` : ""} · {scores.eval.model}
              {scores.eval.judge_model ? ` judged by ${scores.eval.judge_model}` : ""}
            </div>
            <ul className="mt-1 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {scores.rows.map((r) => (
                <li key={r.key} className="flex items-baseline justify-between gap-3" data-testid={`eval-${r.key}`}>
                  <span className="text-ink-soft">{r.label}</span>
                  <span className="font-mono text-xs">
                    {r.value}
                    {r.met === null ? "" : r.met ? " ✓" : " ✗"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-3 text-sm text-ink-soft" data-testid="enrichment-no-eval">
            No evaluation scores were recorded for this bundle&apos;s enrichment.
          </p>
        )
      ) : null}
    </Panel>
  );
}
