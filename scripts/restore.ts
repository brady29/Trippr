/**
 * pnpm db:restore <file | gs://bucket/prefix> [--date YYYY-MM-DD] [--graph NAME] [--yes]
 *
 * Rebuilds the graph from a backup written by `pnpm db:backup` (or the old
 * `pnpm db:export` JSON). With a folder or a gs:// location, the newest
 * backup is used unless --date picks one.
 *
 * It only restores into an empty graph. To restore over production, stop
 * the API, point FALKORDB_GRAPH (or the Neo4j database) at a fresh graph,
 * restore there, check the app against it, and then switch the API over;
 * docs/operations.md walks through it. --graph overrides FALKORDB_GRAPH.
 *
 * Place vectors are not in backups; run the catalogue load job afterwards
 * (pnpm db:load-bundle) to put them back.
 */
import { applySchema, createGraphClient, dbConfigFromEnv } from "@trippr/api/db";
import { restoreGraph } from "@trippr/api/backup";
import { decodeBackup, openBackupStore } from "@trippr/api/backup-store";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const source = args.find((a, i) => !a.startsWith("--") && !["--date", "--graph"].includes(args[i - 1] ?? ""));
if (!source) {
  console.error("Usage: pnpm db:restore <file | folder | gs://bucket/prefix> [--date YYYY-MM-DD] [--graph NAME]");
  process.exit(2);
}

const isFile = !source.startsWith("gs://") && statSync(source, { throwIfNoEntry: false })?.isFile();
let backup;
if (isFile) {
  backup = decodeBackup(readFileSync(source));
} else {
  const store = await openBackupStore(source);
  const dates = await store.dates();
  const date = option("--date") ?? dates.at(-1);
  if (!date || !dates.includes(date)) throw new Error(`No backup${option("--date") ? ` for ${option("--date")}` : ""} in ${store.location}`);
  console.log(`Restoring the backup of ${date} from ${store.location}`);
  backup = await store.read(date);
}

const config = dbConfigFromEnv();
const graph = option("--graph");
const db = await createGraphClient(graph ? { ...config, FALKORDB_GRAPH: graph } : config);
try {
  const file = resolve(import.meta.dirname, `../db/schema/${db.dialect}.cypher`);
  await applySchema(db, readFileSync(file, "utf8"));
  const started = Date.now();
  const counts = await restoreGraph(db, backup, { log: (m) => console.log(`  ${m}`) });
  console.log(
    `Restored ${counts.nodes} nodes and ${counts.relationships} relationships (exported ${backup.exportedAt}) in ${((Date.now() - started) / 1000).toFixed(1)} s; counts checked.`,
  );
  console.log("Place vectors are not in backups: run pnpm db:load-bundle to put them back.");
} finally {
  await db.close();
}
