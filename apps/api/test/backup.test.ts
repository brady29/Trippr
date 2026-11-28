import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applySchema, createGraphClient } from "../src/db";
import { backupCounts, compareCounts, exportGraph, graphCounts, restoreGraph } from "../src/db/backup";
import { decodeBackup, encodeBackup } from "../src/db/backup-store";
import { startHarness, type Harness } from "./harness";

const ROOT = resolve(import.meta.dirname, "../../..");

describe("backup and restore", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h?.close());

  it("exports the seeded trip and rebuilds an identical graph from it", async () => {
    if (h.db.dialect !== "falkordb") return; // Neo4j Community has one database; the drill needs a second graph.
    const backup = decodeBackup(encodeBackup(await exportGraph(h.db)));
    const counts = backupCounts(backup);
    expect(counts.nodes).toBeGreaterThan(50);
    expect(counts.labels.Trip).toBeGreaterThanOrEqual(1);

    const scratch = await createGraphClient({ ...h.config, FALKORDB_GRAPH: `restore_${randomBytes(4).toString("hex")}` });
    try {
      await applySchema(scratch, readFileSync(resolve(ROOT, "db/schema/falkordb.cypher"), "utf8"));
      await restoreGraph(scratch, backup, { batchSize: 50 });
      expect(compareCounts(counts, await graphCounts(scratch))).toEqual([]);

      // Properties and edges come back as they were, and the scaffolding is gone.
      const [route] = await h.db.query<{ id: string; name: string; stops: number }>(
        "MATCH (r:Route)-[:HAS_STOP]->(s:Stop) RETURN r.id AS id, r.name AS name, count(s) AS stops ORDER BY id LIMIT 1",
      );
      const [copy] = await scratch.query<{ id: string; name: string; stops: number }>(
        "MATCH (r:Route {id: $id})-[:HAS_STOP]->(s:Stop) RETURN r.id AS id, r.name AS name, count(s) AS stops",
        { id: route!.id },
      );
      expect(copy).toEqual(route);
      const [left] = await scratch.query<{ n: number }>("MATCH (n:RestoreTmp) RETURN count(n) AS n");
      expect(left?.n).toBe(0);
      const [bids] = await scratch.query<{ n: number }>("MATCH (n) WHERE n.restoreBid IS NOT NULL RETURN count(n) AS n");
      expect(bids?.n).toBe(0);

      // A second restore into the same graph is refused.
      await expect(restoreGraph(scratch, backup)).rejects.toThrow(/already has/);
    } finally {
      await scratch.dropAll();
      await scratch.close();
    }
  });
});
