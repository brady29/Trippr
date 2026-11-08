import type { Config } from "../config";
import { createFalkorClient } from "./falkordb";
import type { AdminGraphClient } from "./graph";
import { createNeo4jClient } from "./neo4j";

export * from "./graph";
export { applySchema, schemaStatements } from "./schema";

type DbConfig = Pick<
  Config,
  | "DB_DIALECT"
  | "FALKORDB_URL"
  | "FALKORDB_GRAPH"
  | "NEO4J_URI"
  | "NEO4J_USER"
  | "NEO4J_PASSWORD"
  | "NEO4J_DATABASE"
  | "DB_QUERY_TIMEOUT_MS"
>;

export function createGraphClient(config: DbConfig): Promise<AdminGraphClient> {
  if (config.DB_DIALECT === "neo4j") {
    return createNeo4jClient({
      uri: config.NEO4J_URI,
      user: config.NEO4J_USER,
      password: config.NEO4J_PASSWORD,
      database: config.NEO4J_DATABASE,
      timeoutMs: config.DB_QUERY_TIMEOUT_MS,
    });
  }
  return createFalkorClient({
    url: config.FALKORDB_URL,
    graph: config.FALKORDB_GRAPH,
    timeoutMs: config.DB_QUERY_TIMEOUT_MS,
  });
}

/** Database settings from the environment, with the same defaults as the API. */
export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    DB_DIALECT: env.DB_DIALECT === "neo4j" ? "neo4j" : "falkordb",
    FALKORDB_URL: env.FALKORDB_URL ?? "redis://localhost:6379",
    FALKORDB_GRAPH: env.FALKORDB_GRAPH ?? "trippr",
    NEO4J_URI: env.NEO4J_URI ?? "neo4j://localhost:7687",
    NEO4J_USER: env.NEO4J_USER ?? "neo4j",
    NEO4J_PASSWORD: env.NEO4J_PASSWORD ?? "",
    NEO4J_DATABASE: env.NEO4J_DATABASE,
    DB_QUERY_TIMEOUT_MS: Number(env.DB_QUERY_TIMEOUT_MS ?? 5000),
  };
}
