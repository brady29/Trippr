/**
 * Search relevance against the LOADED graph, through the same search service the API uses (vectors, index or exact
 * scan, words, ranking). The labelled queries come from the pipeline, which resolves its label rules to place ids:
 *
 *   cd pipelines
 *   uv run python -m trippr_data eval-search --corpus out/bundles/<date>/places.parquet \
 *       --queries eval/search/queries_bundle.yaml --export-queries out/search-queries.json
 *   cd .. && pnpm eval:search --queries pipelines/out/search-queries.json [--path index|exact|auto] [--limit 10] [--min-mrr 0.5]
 *
 * Query vectors come from the configured embedder (Cloudflare when CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
 * are set, SEARCH_EMBEDDER=fake for a dry run), so it spends a few cents of Workers AI at most (89 short queries).
 * With no embedder it scores the words-only mode, which is the baseline hybrid search has to beat.
 * It reads the graph and writes nothing. Compare its numbers with the Python eval's brute-force cosine: the
 * difference is the cost of the index, the hosted query vector and the word matching.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "./config";
import { connectWithRetry } from "./bootstrap";
import { dbConfigFromEnv } from "./db";
import { createRepositories } from "./repositories";
import { renderMarkdown, summarise, type LabelledQuery } from "./services/search/metrics";
import { createSearch } from "./services/search/service";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = arg("--queries");
if (!file) {
  console.error("usage: pnpm eval:search --queries <queries.json> [--path auto|index|exact] [--limit 10] [--trip <id>] [--json] [--min-mrr 0.5]");
  process.exit(2);
}
const queries = (JSON.parse(readFileSync(file, "utf8")) as { queries: LabelledQuery[] }).queries;
const limit = Number(arg("--limit") ?? 10);
const path = (arg("--path") ?? "auto") as "auto" | "index" | "exact";

// The eval is one process asking many questions: lift the per-member limits, keep everything else as configured.
const config = loadConfig({
  APP_JWT_SECRET: "eval-eval-eval-eval-eval-eval-eval-0",
  ...process.env,
  SEARCH_VECTOR_PATH: path,
  SEARCH_RATE_PER_MINUTE: "100000",
  SEARCH_DAILY_LIMIT: "100000",
});
const startup = { info: () => {}, warn: (obj: unknown, msg?: string) => console.error(msg ?? "warning", JSON.stringify(obj)) };
const db = await connectWithRetry(dbConfigFromEnv(), startup);
try {
  const repos = createRepositories(db);
  const trips = await repos.catalogue.trips();
  const tripId = arg("--trip") ?? (trips.length === 1 ? trips[0]!.id : undefined);
  if (!tripId) throw new Error(`Say which trip with --trip (${trips.map((t) => t.id).join(", ") || "none exist"})`);
  const search = createSearch({ repos, config, log: { warn: (o: unknown, m?: string) => console.error(m ?? "warning", JSON.stringify(o)), info: () => {} } });
  const state = await search.info();
  console.error(
    state
      ? `vectors: ${state.count} places, ${state.model} (${state.dims} dimensions), bundle ${state.bundleDate}; query embedder: ${search.embedderName ?? "none (words only)"}; path: ${path}`
      : "no vectors are loaded; scoring words only",
  );

  const ranked: string[][] = [];
  const engines = new Map<string, number>();
  for (const q of queries) {
    const r = await search.run({ id: "eval", isDemo: false }, tripId, { q: q.text, limit, km: undefined } as Parameters<typeof search.run>[2]);
    const how = r.mode === "hybrid" ? `vectors via the ${r.engine}` : `words only (${r.notice?.code ?? "no vectors"})`;
    engines.set(how, (engines.get(how) ?? 0) + 1);
    ranked.push(r.hits.map((h) => h.activity.id));
  }
  const report = summarise(queries, ranked);
  const used = [...engines].map(([k, n]) => `${k} x${n}`).join(", ");
  if (process.argv.includes("--json")) console.log(JSON.stringify({ how: used, report }, null, 1));
  else console.log(renderMarkdown(report, `Search relevance of the loaded graph (${used}; ${queries.length} queries, top ${limit})`));
  const min = arg("--min-mrr");
  if (min && report.overall.mrr < Number(min)) {
    console.error(`MRR ${report.overall.mrr} is below ${min}`);
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
