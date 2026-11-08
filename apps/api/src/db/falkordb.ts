import { FalkorDB, type Graph } from "falkordb";
import type { AdminGraphClient, Params, QueryOptions } from "./graph";

export interface FalkorOptions {
  url: string;
  graph: string;
  timeoutMs: number;
}

const UNIQUE_CONSTRAINT = /^GRAPH\.CONSTRAINT\s+CREATE\s+UNIQUE\s+NODE\s+(\w+)\s+PROPERTIES\s+(\d+)\s+(.+)$/i;

export async function createFalkorClient(options: FalkorOptions): Promise<AdminGraphClient> {
  const url = new URL(options.url);
  const db = await FalkorDB.connect({
    socket: {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.protocol === "rediss:" ? { tls: true } : {}),
    },
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  });
  const graph: Graph = db.selectGraph(options.graph);

  async function query<T>(cypher: string, params: Params = {}, opts: QueryOptions = {}): Promise<T[]> {
    const run = opts.readOnly ? graph.roQuery.bind(graph) : graph.query.bind(graph);
    const reply = await run<T>(cypher, {
      params: params as never,
      TIMEOUT: opts.timeoutMs ?? options.timeoutMs,
    });
    return (reply.data ?? []) as T[];
  }

  return {
    dialect: "falkordb",
    query,
    async ping() {
      const rows = await query<{ ok: number }>("RETURN 1 AS ok", {}, { readOnly: true });
      return rows[0]?.ok === 1;
    },
    async close() {
      await db.close();
    },
    async applySchemaStatement(statement) {
      const unique = UNIQUE_CONSTRAINT.exec(statement);
      if (unique) {
        const [, label, , props] = unique;
        const properties = props!.trim().split(/\s+/);
        const existing = await graph.listConstraints().catch(() => []);
        const already = existing.some(
          (c) => c.label === label && c.type === "UNIQUE" && properties.every((p) => c.properties.includes(p)),
        );
        if (!already) await graph.createNodeUniqueConstraint(label!, ...properties);
        return;
      }
      try {
        await graph.query(statement);
      } catch (error) {
        // FalkorDB has no IF NOT EXISTS for indexes; re-running a migration is fine.
        if (error instanceof Error && /already indexed|already exists/i.test(error.message)) return;
        throw error;
      }
    },
    async dropAll() {
      const graphs = await db.list();
      if (graphs.includes(options.graph)) await graph.delete();
    },
  };
}
