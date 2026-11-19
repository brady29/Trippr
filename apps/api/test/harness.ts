import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../src/app";
import type { InboxReader } from "../src/services/inbox/reader";
import { loadConfig } from "../src/config";
import { applySchema, createGraphClient, type AdminGraphClient } from "../src/db";
import { migrateGraphExplorer, type ExplorerMigrationResult } from "../src/db/explorer-migration";
import { seedDatabase, type SeedResult } from "../src/db/seed";

const ROOT = resolve(import.meta.dirname, "../../..");
export const SEED_DIR = resolve(ROOT, "seed");

export interface Harness {
  app: FastifyInstance;
  db: AdminGraphClient;
  seed: SeedResult;
  explorer: ExplorerMigrationResult;
  ownerInvite: string;
  close(): Promise<void>;
}

/**
 * A throwaway database for each test run: a uniquely named FalkorDB graph
 * (or the Neo4j database when DB_DIALECT=neo4j), migrated and seeded with
 * the real trip, then deleted afterwards.
 */
export async function startHarness(options: { env?: Record<string, string>; inboxReader?: InboxReader } = {}): Promise<Harness> {
  const graph = `trippr_test_${randomBytes(4).toString("hex")}`;
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    FALKORDB_GRAPH: graph,
    APP_JWT_SECRET: "test-secret-test-secret-test-secret-123",
    AUTH_DEV_LOGIN: "true",
    DEMO_TRIP_ID: "asia-2027",
    LOG_LEVEL: "warn",
    INBOX_LINK_PREVIEWS: "false",
    ANTHROPIC_API_KEY: "",
    ...options.env,
  });
  const db = await createGraphClient(config);
  if (db.dialect === "neo4j") await db.dropAll();
  await applySchema(db, readFileSync(resolve(ROOT, `db/schema/${db.dialect}.cypher`), "utf8"));
  const ownerInvite = `owner-${randomBytes(8).toString("hex")}`;
  const seed = await seedDatabase(db, { seedDir: resolve(ROOT, "seed"), ownerInviteToken: ownerInvite });
  const explorer = await migrateGraphExplorer(db, { seedDir: SEED_DIR });
  const app = await buildApp({ config, db, logger: false, ...(options.inboxReader ? { inboxReader: options.inboxReader } : {}) });
  return {
    app,
    db,
    seed,
    explorer,
    ownerInvite,
    async close() {
      await app.close();
      await db.dropAll();
      await db.close();
    },
  };
}

export type Response<T = any> = { status: number; body: T; headers: Record<string, unknown>; text: string };

/** A tiny client bound to one signed-in user. */
export function client(app: FastifyInstance, token?: string) {
  const call = async <T = any>(method: InjectOptions["method"], url: string, payload?: unknown): Promise<Response<T>> => {
    const res = await app.inject({
      method,
      url,
      ...(payload !== undefined ? { payload: payload as object } : {}),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    let body: any = undefined;
    try {
      body = res.json();
    } catch {
      body = undefined;
    }
    return { status: res.statusCode, body, headers: res.headers, text: res.body };
  };
  return {
    get: <T = any>(url: string) => call<T>("GET", url),
    post: <T = any>(url: string, body?: unknown) => call<T>("POST", url, body ?? {}),
    put: <T = any>(url: string, body?: unknown) => call<T>("PUT", url, body ?? {}),
    patch: <T = any>(url: string, body?: unknown) => call<T>("PATCH", url, body ?? {}),
    del: <T = any>(url: string) => call<T>("DELETE", url),
  };
}

export async function signIn(app: FastifyInstance, name: string) {
  const res = await client(app).post<{ token: string; user: { id: string } }>("/auth/dev-login", { name });
  if (res.status !== 200) throw new Error(`dev-login failed: ${res.status} ${res.text}`);
  return { token: res.body.token, id: res.body.user.id, api: client(app, res.body.token) };
}
