/**
 * pnpm db:migrate [--reset]
 *
 * Applies db/schema/<dialect>.cypher. With --reset, deletes the whole graph
 * first (local development only).
 */
import { applySchema, createGraphClient, dbConfigFromEnv } from "@trippr/api/db";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const config = dbConfigFromEnv();
const db = await createGraphClient(config);
try {
  if (process.argv.includes("--reset")) {
    if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset a production database");
    await db.dropAll();
    console.log("Dropped every node and relationship.");
  }
  const file = resolve(import.meta.dirname, `../db/schema/${db.dialect}.cypher`);
  const count = await applySchema(db, readFileSync(file, "utf8"));
  console.log(`Applied ${count} schema statements from db/schema/${db.dialect}.cypher.`);
} finally {
  await db.close();
}
