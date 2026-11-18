import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config";
import { applySchema, createGraphClient, type AdminGraphClient } from "./db";
import { seedDatabase } from "./db/seed";

type Logger = { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Repo folders, relative to apps/api/src in development. The Docker image sets SCHEMA_DIR and SEED_DIR. */
const repoPath = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

/**
 * Connect to the database, retrying with backoff: on a fresh deploy the
 * FalkorDB VM may still be booting when Cloud Run starts the API.
 */
export async function connectWithRetry(config: Config, log: Logger, attempts = 6): Promise<AdminGraphClient> {
  let delay = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      const db = await createGraphClient(config);
      if (await db.ping()) return db;
      await db.close().catch(() => {});
      throw new Error("ping failed");
    } catch (error) {
      if (attempt >= attempts) throw error;
      log.warn({ attempt, err: error instanceof Error ? error.message : String(error) }, `database not ready, retrying in ${delay} ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, 15_000);
    }
  }
}

/** Optional startup work: apply the schema and run the idempotent seed. */
export async function prepareDatabase(db: AdminGraphClient, config: Config, log: Logger) {
  if (config.DB_AUTO_MIGRATE) {
    const dir = config.SCHEMA_DIR ?? repoPath("db/schema");
    const count = await applySchema(db, readFileSync(join(dir, `${db.dialect}.cypher`), "utf8"));
    log.info({ statements: count, dialect: db.dialect }, "schema applied");
  }
  if (config.DB_AUTO_SEED) {
    const result = await seedDatabase(db, {
      seedDir: config.SEED_DIR ?? repoPath("seed"),
      ownerInviteToken: config.SEED_OWNER_INVITE,
    });
    log.info(
      { tripId: result.tripId, tripCreated: result.tripCreated, routesSeeded: result.routesSeeded, counts: result.counts },
      "seed applied",
    );
    if (result.ownerInvite) {
      const url = `${config.PUBLIC_WEB_URL.replace(/\/$/, "")}/invite/${result.ownerInvite.token}`;
      log.info({ url, expiresAt: result.ownerInvite.expiresAt }, `Claim ownership of the trip: ${url}`);
    }
  }
}
