/**
 * Search relevance metrics, the same definitions as pipelines/src/trippr_data/embed/evaluate.py (binary relevance):
 * recall@k = relevant found in the top k / all relevant; success@k = 1 if any is; MRR = 1 / rank of the first;
 * NDCG@10 with gains of 1. Numbers from the Python eval (brute-force cosine on the bundle) and from this one
 * (the loaded graph through the real search service) are therefore comparable.
 */
export interface LabelledQuery {
  id: string;
  text: string;
  lang: string;
  kind: string;
  relevant: string[];
}

export const KS = [1, 5, 10] as const;

export function scoreQuery(ranked: string[], relevant: Set<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of KS) {
    const hits = ranked.slice(0, k).filter((id) => relevant.has(id)).length;
    out[`recall@${k}`] = relevant.size ? hits / relevant.size : 0;
    out[`success@${k}`] = hits > 0 ? 1 : 0;
  }
  const first = ranked.findIndex((id) => relevant.has(id));
  out.mrr = first >= 0 ? 1 / (first + 1) : 0;
  const dcg = ranked.slice(0, 10).reduce((s, id, i) => s + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  let ideal = 0;
  for (let i = 0; i < Math.min(10, relevant.size); i++) ideal += 1 / Math.log2(i + 2);
  out["ndcg@10"] = ideal ? dcg / ideal : 0;
  return out;
}

export const COLUMNS = ["recall@1", "recall@5", "recall@10", "success@1", "success@5", "mrr", "ndcg@10"] as const;

export type Means = Record<string, number> & { queries: number; mrr: number };
const mean = (rows: Record<string, number>[]): Means =>
  ({
    queries: rows.length,
    ...Object.fromEntries(COLUMNS.map((c) => [c, Math.round((rows.reduce((s, r) => s + r[c]!, 0) / (rows.length || 1)) * 1e4) / 1e4])),
  }) as Means;

export interface EvalReport {
  overall: Means;
  byKind: Record<string, Means>;
  byLang: Record<string, Means>;
  perQuery: { id: string; text: string; kind: string; lang: string; relevant: number; mrr: number; top3: string[] }[];
}

/** Score every query's ranked ids (best first) and summarise overall, by kind and by language. */
export function summarise(queries: LabelledQuery[], ranked: string[][]): EvalReport {
  const scored = queries.map((q, i) => scoreQuery(ranked[i] ?? [], new Set(q.relevant)));
  const group = (key: "kind" | "lang") => {
    const buckets = new Map<string, Record<string, number>[]>();
    queries.forEach((q, i) => buckets.set(q[key], [...(buckets.get(q[key]) ?? []), scored[i]!]));
    return Object.fromEntries([...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([k, rows]) => [k, mean(rows)]));
  };
  return {
    overall: mean(scored),
    byKind: group("kind"),
    byLang: group("lang"),
    perQuery: queries.map((q, i) => ({ id: q.id, text: q.text, kind: q.kind, lang: q.lang, relevant: q.relevant.length, mrr: Math.round(scored[i]!.mrr! * 1e4) / 1e4, top3: (ranked[i] ?? []).slice(0, 3) })),
  };
}

export function renderMarkdown(report: EvalReport, title: string): string {
  const line = (label: string, m: Record<string, number>) => `| ${label} | ${m.queries} | ${COLUMNS.map((c) => m[c]!.toFixed(3)).join(" | ")} |`;
  return [
    title,
    "",
    `| | queries | ${COLUMNS.join(" | ")} |`,
    `|---|---|${COLUMNS.map(() => "---").join("|")}|`,
    line("**all**", report.overall),
    ...Object.entries(report.byKind).map(([k, m]) => line(`kind: ${k}`, m)),
    ...Object.entries(report.byLang).map(([k, m]) => line(`lang: ${k}`, m)),
    "",
  ].join("\n");
}
