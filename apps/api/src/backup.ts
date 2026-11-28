/**
 * The daily backup, run as a Cloud Run Job (node dist/backup.js) beside the
 * API, so it reaches the FalkorDB VM over the VPC, or by hand (pnpm db:backup).
 *
 *   --location L   gs://bucket/prefix or a local folder (default BACKUP_LOCATION, else ./backups)
 *   --drill        after writing, restore the backup into a scratch graph and check the counts
 *                  match (FalkorDB only; the scratch graph is deleted afterwards)
 *   --no-prune     keep every old backup this time
 *
 * Old backups are pruned to every day of the last BACKUP_KEEP_DAILY days (14),
 * one a week for BACKUP_KEEP_WEEKLY weeks (8) and one a month for
 * BACKUP_KEEP_MONTHLY months (12). Exit code 1 means the backup or the drill
 * failed, so the scheduler flags it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySchema, createGraphClient, dbConfigFromEnv } from "./db";
import { backupCounts, backupsToPrune, exportGraph, restoreGraph } from "./db/backup";
import { openBackupStore } from "./db/backup-store";

const log = (level: "info" | "warn", obj: object, msg: string) =>
  (level === "info" ? console.log : console.warn)(JSON.stringify({ level: level === "info" ? 30 : 40, msg, ...obj }));

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const int = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

const env = process.env;
const location = option("--location") ?? env.BACKUP_LOCATION ?? "backups";
const dbConfig = dbConfigFromEnv();
const today = new Date().toISOString().slice(0, 10);
const schemaDir = env.SCHEMA_DIR ?? fileURLToPath(new URL("../../../db/schema", import.meta.url));

let exitCode = 0;
const db = await createGraphClient(dbConfig);
try {
  const started = Date.now();
  const backup = await exportGraph(db);
  const store = await openBackupStore(location);
  const written = await store.write(today, backup);
  const counts = backupCounts(backup);
  log("info", { file: written.name, bytes: written.bytes, nodes: counts.nodes, relationships: counts.relationships, ms: Date.now() - started }, "backup written");

  if (flag("--drill") || env.BACKUP_DRILL === "true") {
    if (db.dialect !== "falkordb") {
      log("warn", { dialect: db.dialect }, "restore drill skipped: it needs a scratch graph, which only FalkorDB offers here");
    } else {
      const drillGraph = `${dbConfig.FALKORDB_GRAPH}_restore_drill`;
      const scratch = await createGraphClient({ ...dbConfig, FALKORDB_GRAPH: drillGraph });
      try {
        await scratch.dropAll();
        await applySchema(scratch, readFileSync(join(schemaDir, "falkordb.cypher"), "utf8"));
        const drillStart = Date.now();
        // Read it back from the store, so the drill also proves the file is readable.
        await restoreGraph(scratch, await store.read(today));
        log("info", { graph: drillGraph, ms: Date.now() - drillStart }, "restore drill passed: the scratch graph matches the backup");
      } finally {
        await scratch.dropAll().catch(() => {});
        await scratch.close();
      }
    }
  }

  if (!flag("--no-prune")) {
    const prune = backupsToPrune(await store.dates(), today, {
      daily: int(env.BACKUP_KEEP_DAILY, 14),
      weekly: int(env.BACKUP_KEEP_WEEKLY, 8),
      monthly: int(env.BACKUP_KEEP_MONTHLY, 12),
    });
    for (const date of prune) await store.remove(date);
    if (prune.length) log("info", { removed: prune }, "old backups pruned");
  }
} catch (error) {
  log("warn", { err: error instanceof Error ? error.message : String(error) }, "backup failed");
  exitCode = 1;
} finally {
  await db.close();
}
process.exit(exitCode);
