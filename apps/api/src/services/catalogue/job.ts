import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectWithRetry } from "../../bootstrap";
import { applySchema, dbConfigFromEnv, type AdminGraphClient } from "../../db";
import { createRepositories } from "../../repositories";
import { openStore, selectBundle, type BundleStore } from "./bundle";
import {
  defaultEmbeddingsLocation,
  loadEmbeddings,
  preflightEmbeddings,
  readEmbeddingsRun,
  type EmbeddingsRun,
  type EmbeddingsSummary,
} from "./embeddings";
import { loadBundle, resolveTrip, type LoadSummary } from "./loader";

export const USAGE = `Load the newest passing data bundle into the graph.

  node dist/load-bundle.js [--bundle <folder or gs://bucket/bundles>] [--date YYYY-MM-DD] [--trip <id>] [--dry-run] [--json]
                           [--embeddings <folder or gs://bucket/embeddings>] [--embeddings-date YYYY-MM-DD]
                           [--no-embeddings] [--rebuild-index]

  --bundle   Folder holding bundles/<date>/ directories, or a Cloud Storage location.
             Default: $BUNDLE_LOCATION, else gs://$DATA_BUCKET/bundles
  --date     Load this bundle instead of the newest one that passed its checks
  --trip     The trip whose library gets the places (default $CATALOGUE_TRIP_ID, else the only trip)
  --dry-run  Work out and print what would change; write nothing
  --json     Print the summary as one JSON line

  Place vectors for semantic search (from the pipeline's embed stage):
  --embeddings        Folder holding embeddings/<date>/ runs. Default: $EMBEDDINGS_LOCATION, else the folder named
                      embeddings next to the bundles folder (gs://bucket/bundles -> gs://bucket/embeddings)
  --embeddings-date   Use this run instead of the one with the bundle's date
  --no-embeddings     Load places only; leave the vectors as they are
  --rebuild-index     The model or vector size changed: drop the vector index and every stored vector, then load this run.
                      Without it, such a run is refused and nothing at all is loaded.`;

export interface JobArgs {
  bundle?: string;
  date?: string;
  trip?: string;
  dryRun: boolean;
  json: boolean;
  help: boolean;
  embeddings?: string;
  embeddingsDate?: string;
  noEmbeddings?: boolean;
  rebuildIndex?: boolean;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): JobArgs {
  const args: JobArgs = { dryRun: false, json: false, help: false };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--bundle") args.bundle = value(i++, a);
    else if (a === "--date") args.date = value(i++, a);
    else if (a === "--trip") args.trip = value(i++, a);
    else if (a === "--embeddings") args.embeddings = value(i++, a);
    else if (a === "--embeddings-date") args.embeddingsDate = value(i++, a);
    else if (a === "--no-embeddings") args.noEmbeddings = true;
    else if (a === "--rebuild-index") args.rebuildIndex = true;
    else throw new Error(`Unknown option ${a}`);
  }
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error("--date must look like 2026-11-22");
  if (args.embeddingsDate && !/^\d{4}-\d{2}-\d{2}$/.test(args.embeddingsDate)) throw new Error("--embeddings-date must look like 2026-11-22");
  args.embeddings ??= env.EMBEDDINGS_LOCATION || undefined;
  args.bundle ??= env.BUNDLE_LOCATION || (env.DATA_BUCKET ? `gs://${env.DATA_BUCKET.replace(/^gs:\/\//, "").replace(/\/$/, "")}/bundles` : undefined);
  args.trip ??= env.CATALOGUE_TRIP_ID || undefined;
  return args;
}

export interface JobResult {
  exitCode: number;
  summary?: LoadSummary;
  skipped?: { date: string; reason: string }[];
  /** What was done with place vectors; absent when there were none to load. */
  embeddings?: EmbeddingsSummary;
}

export interface JobDeps {
  /** Tests pass an open database and a store; the Cloud Run Job opens its own. */
  db?: AdminGraphClient;
  store?: BundleStore;
  /** Where the embeddings runs are (tests); otherwise from --embeddings or next to the bundles folder. */
  embeddingsStore?: BundleStore;
  log?: (line: string) => void;
}

/** The Cloud Run Job's work: pick a bundle, load it, print what happened. Exit code 0 when it loaded (or had nothing new). */
export async function runLoadJob(args: JobArgs, deps: JobDeps = {}, env: NodeJS.ProcessEnv = process.env): Promise<JobResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const store = deps.store ?? (args.bundle ? await openStore(args.bundle) : undefined);
  if (!store) throw new Error("Say where the bundles are: --bundle, BUNDLE_LOCATION or DATA_BUCKET");

  const choice = await selectBundle(store, args.date);
  for (const s of choice.skipped) log(`skipped bundle ${s.date}: ${s.reason}`);
  if (!choice.bundle) {
    log(`no usable bundle in ${store.location}`);
    return { exitCode: 1, skipped: choice.skipped };
  }
  const { bundle } = choice;
  log(`bundle ${bundle.date}: ${bundle.places.length} places, ${bundle.manifest.counts.cities} cities, input ${bundle.manifest.input}`);

  // Place vectors for the same date, read and verified before the database is touched.
  const run = await findEmbeddings(args, deps, store, bundle.date, log);

  const owns = !deps.db;
  const startup = { info: () => {}, warn: (obj: unknown, msg?: string) => log(`${msg ?? "warning"} ${JSON.stringify(obj)}`) };
  const db = deps.db ?? (await connectWithRetry(dbConfigFromEnv(env), startup));
  try {
    // The constraints MERGE relies on; idempotent.
    const schemaDir = env.SCHEMA_DIR ?? fileURLToPath(new URL("../../../../../db/schema", import.meta.url));
    if (!args.dryRun) await applySchema(db, readFileSync(join(schemaDir, `${db.dialect}.cypher`), "utf8"));
    const repos = createRepositories(db);
    const tripId = await resolveTrip(repos, args.trip);
    // A run from another model or size is refused here, before a single place is written.
    if (run) await preflightEmbeddings(repos, run, bundle.places, { rebuildIndex: Boolean(args.rebuildIndex) });
    const summary = await loadBundle(repos, bundle, { tripId, dryRun: args.dryRun });
    log(
      `${summary.dryRun ? "dry run, nothing written: would have " : ""}` +
        `created ${summary.created}, refreshed ${summary.refreshed}, unchanged ${summary.unchanged}, ` +
        `adopted ${summary.adopted.length} hand-written, unlisted ${summary.unlisted}, removed ${summary.removed}` +
        (summary.skippedHidden ? `, left ${summary.skippedHidden} deleted places alone` : "") +
        ` (trip ${tripId})`,
    );
    if (summary.stay) {
      const s = summary.stay;
      log(
        `${summary.dryRun ? "would have " : ""}stay: ${s.areas} areas, ${s.markets} cities (${s.cells} map cells), hotels created ${s.hotels.created}, ` +
          `refreshed ${s.hotels.refreshed}, unchanged ${s.hotels.unchanged}, removed ${s.hotels.removed}` +
          (s.hotels.skippedNoArea ? `, ${s.hotels.skippedNoArea} skipped (their Area is not in the graph)` : ""),
      );
    }
    for (const a of summary.adopted) log(`  matched "${a.title}" (${a.activityId}) to ${a.placeId}`);
    let embeddings: EmbeddingsSummary | undefined;
    if (run) {
      embeddings = args.dryRun
        ? await dryRunEmbeddings(repos, run, bundle.places, Boolean(args.rebuildIndex))
        : await loadEmbeddings(repos, run, bundle.places, { rebuildIndex: Boolean(args.rebuildIndex), bundleDate: bundle.date });
      log(
        `${embeddings.dryRun ? "dry run, nothing written: would have " : ""}` +
          `vectors from ${embeddings.date} (${embeddings.model}, ${embeddings.dims} dimensions): ` +
          `${embeddings.covered} of ${bundle.places.length} places covered, ${embeddings.dryRun ? "to write" : "wrote"} ${embeddings.written}, unchanged ${embeddings.unchanged}` +
          (embeddings.rebuilt ? ", index rebuilt" : ""),
      );
    }
    if (args.json) log(JSON.stringify({ ...summary, ...(embeddings ? { embeddings } : {}) }));
    return { exitCode: 0, summary, skipped: choice.skipped, ...(embeddings ? { embeddings } : {}) };
  } finally {
    if (owns) await db.close();
  }
}

/**
 * The embeddings run to load with this bundle, or null. Not finding one is normal (search stays on words, or on the
 * vectors already loaded); a run that exists but fails its checks is skipped with the reason, unless the operator
 * named it, when it is an error.
 */
async function findEmbeddings(args: JobArgs, deps: JobDeps, bundles: BundleStore, bundleDate: string, log: (line: string) => void): Promise<EmbeddingsRun | null> {
  if (args.noEmbeddings) return null;
  const named = Boolean(args.embeddings || args.embeddingsDate);
  const location = args.embeddings ?? defaultEmbeddingsLocation(bundles.location);
  const store = deps.embeddingsStore ?? (location ? await openStore(location) : undefined);
  if (!store) {
    log("no embeddings location (--embeddings or $EMBEDDINGS_LOCATION): place vectors are not loaded");
    return null;
  }
  const date = args.embeddingsDate ?? bundleDate;
  const dates = await store.dates().catch(() => [] as string[]);
  if (!dates.includes(date)) {
    if (named) throw new Error(`There are no embeddings for ${date} in ${store.location}`);
    log(`no embeddings for ${date} in ${store.location}: place vectors are not loaded (run embed on the laptop, then upload)`);
    return null;
  }
  try {
    return await readEmbeddingsRun(store, date);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (named) throw new Error(`The embeddings of ${date} cannot be used: ${reason}`);
    log(`skipped embeddings ${date}: ${reason}`);
    return null;
  }
}

async function dryRunEmbeddings(
  repos: ReturnType<typeof createRepositories>,
  run: EmbeddingsRun,
  places: { id: string }[],
  rebuildIndex: boolean,
): Promise<EmbeddingsSummary> {
  const { coverage, rebuild } = await preflightEmbeddings(repos, run, places, { rebuildIndex });
  return {
    date: run.date,
    model: run.manifest.model,
    dims: run.manifest.dims,
    dryRun: true,
    covered: coverage.covered,
    missing: coverage.missing,
    written: coverage.covered,
    unchanged: 0,
    rebuilt: rebuild,
  };
}
