/**
 * pnpm db:export [file]
 *
 * Writes every node and relationship to a JSON file that either database can
 * be rebuilt from (place vectors excluded, see below). Used by the weekly backup workflow; works the same against
 * FalkorDB and Neo4j.
 */
import { createGraphClient, dbConfigFromEnv } from "@trippr/api/db";
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? `trippr-export-${new Date().toISOString().slice(0, 10)}.json`;
const db = await createGraphClient(dbConfigFromEnv());
try {
  const nodes = await db.query("MATCH (n) RETURN id(n) AS id, labels(n) AS labels, properties(n) AS props", {}, { readOnly: true });
  // Place vectors (Activity.embedding, 4 KB each) are not backed up: the load job rewrites them from the embeddings run.
  for (const n of nodes as { props?: Record<string, unknown> }[]) if (n.props) delete n.props.embedding;
  const relationships = await db.query(
    "MATCH (a)-[r]->(b) RETURN id(a) AS start, id(b) AS end, type(r) AS type, properties(r) AS props",
    {},
    { readOnly: true },
  );
  writeFileSync(out, JSON.stringify({ exportedAt: new Date().toISOString(), dialect: db.dialect, nodes, relationships }, null, 1));
  console.log(`Exported ${nodes.length} nodes and ${relationships.length} relationships to ${out}`);
} finally {
  await db.close();
}
