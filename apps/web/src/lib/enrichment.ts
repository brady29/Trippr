import type { ActivityEnrichment, BestTime, DataEnrichmentView, EnrichEvalView, PriceLevel } from "@trippr/contracts";

/** Labels and small helpers for the AI-written fields on activities (the enrichment stage). */

export const BEST_TIME_LABEL: Record<BestTime, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
  night: "Night",
  any: "Any time",
};

export const PRICE_LABEL: Record<PriceLevel, string> = { free: "Free", $: "$", $$: "$$", $$$: "$$$" };

/** The sentence shown with every AI-written summary when the data did not carry its own. */
export const DEFAULT_AI_LABEL = "Summary written by AI";

/** "45 min", "1 h", "1 h 30 min", "3 days" for a visit of `minutes`. */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes >= 24 * 60) {
    const days = Math.round(minutes / (24 * 60));
    return days === 1 ? "1 day" : `${days} days`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "Up to 30 min", "Up to 1 h" for the duration filter. */
export const durationMaxLabel = (max: number) => `Up to ${durationLabel(max)}`;

/** The label that goes with a summary, or null when the summary is not AI-written (or there is none). */
export function aiLabelFor(e: ActivityEnrichment | undefined): string | null {
  if (!e?.summary || !e.summaryAi) return null;
  return e.aiLabel?.trim() || DEFAULT_AI_LABEL;
}

/**
 * The AI-suggested readable name, shown as a subtitle only when the record's own name is generic or formal.
 * Never a replacement for the title, and not shown when it only repeats it.
 */
export function genericSubtitle(title: string, e: ActivityEnrichment | undefined): string | null {
  if (!e?.isGenericName || !e.displayName) return null;
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  return same(e.displayName, title) ? null : e.displayName;
}

export interface Badge {
  key: string;
  label: string;
  title: string;
}

/** Duration, best time and indoor badges (plus price and what it is good for) for an activity card. */
export function enrichmentBadges(e: ActivityEnrichment | undefined): Badge[] {
  if (!e) return [];
  const out: Badge[] = [];
  if (e.durationMin != null) out.push({ key: "duration", label: durationLabel(e.durationMin), title: "Typical visit (AI estimate)" });
  if (e.bestTime) {
    out.push({
      key: "best-time",
      label: e.bestTime === "any" ? "Any time of day" : `Best: ${BEST_TIME_LABEL[e.bestTime].toLowerCase()}`,
      title: "Best time of day (AI estimate)",
    });
  }
  if (e.indoor != null) out.push({ key: "indoor", label: e.indoor ? "Indoor" : "Outdoor", title: e.indoor ? "Mostly indoors (AI estimate)" : "Mostly outdoors (AI estimate)" });
  if (e.priceLevel) out.push({ key: "price", label: PRICE_LABEL[e.priceLevel], title: "Price level (AI estimate)" });
  for (const g of e.goodFor) out.push({ key: `good-${g}`, label: `Good for ${g}`, title: "Suits (AI estimate)" });
  return out;
}

/** "Written by claude-haiku-5-5 on 2026-11-18" for the label's tooltip. */
export function provenanceNote(e: ActivityEnrichment): string {
  const when = e.enrichedAt ? ` on ${e.enrichedAt.slice(0, 10)}` : "";
  return e.model ? `Written by ${e.model}${when}. It can be wrong; check before you rely on it.` : "It can be wrong; check before you rely on it.";
}

// --- the Data page ----------------------------------------------------------------------------------

const pct = (v: number | null | undefined) => (v == null ? "n/a" : `${(v * 100).toFixed(v >= 0.995 || v === 0 ? 0 : 1)}%`);

export interface EvalRow {
  key: string;
  label: string;
  value: string;
  /** Whether the pipeline's own target for this score was met; null when it has no target. */
  met: boolean | null;
}

const EVAL_ROWS: { key: string; label: string; target?: string }[] = [
  { key: "tag_f1", label: "Tag F1", target: "tag_f1" },
  { key: "valid_rate", label: "Valid answers", target: "valid_answers" },
  { key: "duration_within_tolerance", label: "Duration within tolerance" },
  { key: "best_time_accuracy", label: "Best time correct" },
  { key: "indoor_accuracy", label: "Indoor or outdoor correct" },
  { key: "summary_judge_unsupported_rate", label: "Summaries with unsupported claims (judge)", target: "unsupported_summaries" },
  { key: "summary_rule_unsupported_rate", label: "Summaries with unsupported claims (rule check)" },
  { key: "display_name_match", label: "Suggested names that match" },
];

/** The enrichment eval scores in the manifest, as rows for the Data page. Empty when there are none. */
export function evalRows(evals: Record<string, unknown> | undefined): { eval: EnrichEvalView; rows: EvalRow[] } | null {
  const raw = evals?.enrich as Partial<EnrichEvalView> | undefined;
  if (!raw || typeof raw !== "object" || !raw.metrics) return null;
  const metrics = raw.metrics;
  const targets = raw.targets ?? {};
  const judged = metrics.summary_judge_unsupported_rate != null;
  const rows = EVAL_ROWS.filter((r) => metrics[r.key] != null)
    // The judge's score replaces the rule check's when the eval ran the judge.
    .filter((r) => !(judged && r.key === "summary_rule_unsupported_rate"))
    .map((r) => ({
      key: r.key,
      label: r.label,
      value: pct(metrics[r.key]),
      met: r.target && r.target in targets ? Boolean(targets[r.target]) : null,
    }));
  return { eval: { model: raw.model ?? "unknown", judge_model: raw.judge_model ?? null, metrics, targets }, rows };
}

/** "20,000 of 24,000 places (83%)" style numbers for the Data page. */
export function coverage(e: DataEnrichmentView, totalPlaces: number): string {
  const share = totalPlaces > 0 ? ` (${Math.round((e.places / totalPlaces) * 100)}%)` : "";
  return `${e.places.toLocaleString("en-CA")} of ${totalPlaces.toLocaleString("en-CA")} places${share}`;
}
