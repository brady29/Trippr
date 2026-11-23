import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectWithRetry } from "../../bootstrap";
import { applySchema, dbConfigFromEnv, type AdminGraphClient } from "../../db";
import { createRepositories } from "../../repositories";
import { openStore, selectBundle, type BundleStore } from "./bundle";
import { loadBundle, resolveTrip, type LoadSummary } from "./loader";

export const USAGE = `Load the newest passing data bundle into the graph.

  node dist/load-bundle.js [--bundle <folder or gs://bucket/bundles>] [--date YYYY-MM-DD] [--trip <id>] [--dry-run] [--json]

  --bundle   Folder holding bundles/<date>/ directories, or a Cloud Storage location.
             Default: $BUNDLE_LOCATION, else gs://$DATA_BUCKET/bundles
  --date     Load this bundle instead of the newest one that passed its checks
  --trip     The trip whose library gets the places (default $CATALOGUE_TRIP_ID, else the only trip)
  --dry-run  Work out and print what would change; write nothing
  --json     Print the summary as one JSON line`;

export interface JobArgs {
  bundle?: string;
  date?: string;
  trip?: string;
  dryRun: boolean;
  json: boolean;
  help: boolean;
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
    else throw new Error(`Unknown option ${a}`);
  }
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error("--date must look like 2026-11-22");
  args.bundle ??= env.BUNDLE_LOCATION || (env.DATA_BUCKET ? `gs://${env.DATA_BUCKET.replace(/^gs:\/\//, "").replace(/\/$/, "")}/bundles` : undefined);
  args.trip ??= env.CATALOGUE_TRIP_ID || undefined;
  return args;
}

export interface JobResult {
  exitCode: number;
  summary?: LoadSummary;
  skipped?: { date: string; reason: string }[];
}

export interface JobDeps {
  /** Tests pass an open database and a store; the Cloud Run Job opens its own. */
  db?: AdminGraphClient;
  store?: BundleStore;
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

  const owns = !deps.db;
  const startup = { info: () => {}, warn: (obj: unknown, msg?: string) => log(`${msg ?? "warning"} ${JSON.stringify(obj)}`) };
  const db = deps.db ?? (await connectWithRetry(dbConfigFromEnv(env), startup));
  try {
    // The constraints MERGE relies on; idempotent.
    const schemaDir = env.SCHEMA_DIR ?? fileURLToPath(new URL("../../../../../db/schema", import.meta.url));
    if (!args.dryRun) await applySchema(db, readFileSync(join(schemaDir, `${db.dialect}.cypher`), "utf8"));
    const repos = createRepositories(db);
    const tripId = await resolveTrip(repos, args.trip);
    const summary = await loadBundle(repos, bundle, { tripId, dryRun: args.dryRun });
    log(
      `${summary.dryRun ? "dry run, nothing written: would have " : ""}` +
        `created ${summary.created}, refreshed ${summary.refreshed}, unchanged ${summary.unchanged}, ` +
        `adopted ${summary.adopted.length} hand-written, unlisted ${summary.unlisted}, removed ${summary.removed}` +
        (summary.skippedHidden ? `, left ${summary.skippedHidden} deleted places alone` : "") +
        ` (trip ${tripId})`,
    );
    for (const a of summary.adopted) log(`  matched "${a.title}" (${a.activityId}) to ${a.placeId}`);
    if (args.json) log(JSON.stringify(summary));
    return { exitCode: 0, summary, skipped: choice.skipped };
  } finally {
    if (owns) await db.close();
  }
}
