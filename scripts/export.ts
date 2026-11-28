/**
 * pnpm db:export [file]
 *
 * Writes every node and relationship to a JSON file that either database can
 * be rebuilt from with `pnpm db:restore` (place vectors excluded: the load
 * job rewrites them). A name ending in .gz is gzipped. The daily backup job
 * (`pnpm db:backup`, docs/operations.md) uses the same export.
 */
import { createGraphClient, dbConfigFromEnv } from "@trippr/api/db";
import { backupCounts, exportGraph } from "@trippr/api/backup";
import { encodeBackup } from "@trippr/api/backup-store";
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? `trippr-export-${new Date().toISOString().slice(0, 10)}.json`;
const db = await createGraphClient(dbConfigFromEnv());
try {
  const backup = await exportGraph(db);
  writeFileSync(out, out.endsWith(".gz") ? encodeBackup(backup) : JSON.stringify(backup, null, 1));
  const counts = backupCounts(backup);
  console.log(`Exported ${counts.nodes} nodes and ${counts.relationships} relationships to ${out}`);
} finally {
  await db.close();
}
