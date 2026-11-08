import neo4j, { type Driver } from "neo4j-driver";
import type { AdminGraphClient, Params, QueryOptions } from "./graph";

export interface Neo4jOptions {
  uri: string;
  user: string;
  password: string;
  database?: string;
  timeoutMs: number;
}

/**
 * JavaScript numbers are floats, and Neo4j stores floats as floats: a stop
 * order of 2 would come back as 2.0 and `LIMIT $n` would fail. Send every
 * whole number as a Neo4j integer instead.
 */
function toNeo4j(value: unknown): unknown {
  if (typeof value === "number" && Number.isInteger(value)) return neo4j.int(value);
  if (Array.isArray(value)) return value.map(toNeo4j);
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toNeo4j(v)]));
  }
  return value;
}

export async function createNeo4jClient(options: Neo4jOptions): Promise<AdminGraphClient> {
  const driver: Driver = neo4j.driver(options.uri, neo4j.auth.basic(options.user, options.password), {
    disableLosslessIntegers: true,
  });
  await driver.verifyConnectivity();

  async function query<T>(cypher: string, params: Params = {}, opts: QueryOptions = {}): Promise<T[]> {
    const session = driver.session({
      ...(options.database ? { database: options.database } : {}),
      defaultAccessMode: opts.readOnly ? neo4j.session.READ : neo4j.session.WRITE,
    });
    try {
      const config = { timeout: opts.timeoutMs ?? options.timeoutMs };
      const work = (tx: { run: (q: string, p: unknown) => Promise<{ records: { toObject(): unknown }[] }> }) =>
        tx.run(cypher, toNeo4j(params));
      const result = opts.readOnly ? await session.executeRead(work, config) : await session.executeWrite(work, config);
      return result.records.map((r) => r.toObject() as T);
    } finally {
      await session.close();
    }
  }

  return {
    dialect: "neo4j",
    query,
    async ping() {
      const rows = await query<{ ok: number }>("RETURN 1 AS ok", {}, { readOnly: true });
      return rows[0]?.ok === 1;
    },
    async close() {
      await driver.close();
    },
    async applySchemaStatement(statement) {
      await query(statement);
    },
    async dropAll() {
      await query("MATCH (n) DETACH DELETE n");
    },
  };
}
