import type { GraphClient } from "./graph";

/**
 * Whole-graph backup and restore, portable between FalkorDB and Neo4j.
 *
 * The export is every node (labels and properties) and every relationship
 * (type, properties and the internal ids of its ends). Place vectors
 * (Activity.embedding) are left out: they are 4 KB each and the catalogue
 * load job rewrites them from the embeddings run.
 *
 * Restore rebuilds the graph from that file in an empty database: nodes are
 * created in batches with a temporary RestoreTmp label and restoreBid
 * property (the id they had in the export), an index on that pair makes the
 * relationship matches cheap, and both are removed at the end.
 */

export const BACKUP_FORMAT = 1;

export interface BackupNode {
  id: number;
  labels: string[];
  props: Record<string, unknown>;
}

export interface BackupRelationship {
  start: number;
  end: number;
  type: string;
  props: Record<string, unknown>;
}

export interface GraphBackup {
  format?: number;
  exportedAt: string;
  dialect: string;
  nodes: BackupNode[];
  relationships: BackupRelationship[];
}

export interface BackupCounts {
  nodes: number;
  relationships: number;
  /** Nodes per label (a node with two labels counts for both). */
  labels: Record<string, number>;
  /** Relationships per type. */
  types: Record<string, number>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TMP_LABEL = "RestoreTmp";
const TMP_PROP = "restoreBid";

/** Labels and relationship types are written into the Cypher text, so only plain identifiers are accepted. */
export function safeName(name: string): string {
  if (!NAME.test(name) || name === TMP_LABEL) throw new Error(`Refusing to restore an unusual label or type: ${JSON.stringify(name)}`);
  return name;
}

export async function exportGraph(db: GraphClient, now: () => Date = () => new Date()): Promise<GraphBackup> {
  const nodes = await db.query<BackupNode>("MATCH (n) RETURN id(n) AS id, labels(n) AS labels, properties(n) AS props", {}, { readOnly: true, timeoutMs: 120_000 });
  for (const n of nodes) {
    n.props = { ...(n.props ?? {}) };
    delete n.props.embedding;
  }
  const relationships = await db.query<BackupRelationship>(
    "MATCH (a)-[r]->(b) RETURN id(a) AS start, id(b) AS end, type(r) AS type, properties(r) AS props",
    {},
    { readOnly: true, timeoutMs: 120_000 },
  );
  for (const r of relationships) r.props = { ...(r.props ?? {}) };
  return { format: BACKUP_FORMAT, exportedAt: now().toISOString(), dialect: db.dialect, nodes, relationships };
}

/** What a backup holds, by label and type; restore checks its result against this. */
export function backupCounts(backup: Pick<GraphBackup, "nodes" | "relationships">): BackupCounts {
  const labels: Record<string, number> = {};
  const types: Record<string, number> = {};
  for (const n of backup.nodes) for (const l of n.labels) labels[l] = (labels[l] ?? 0) + 1;
  for (const r of backup.relationships) types[r.type] = (types[r.type] ?? 0) + 1;
  return { nodes: backup.nodes.length, relationships: backup.relationships.length, labels, types };
}

/** The same counts, read from a live graph. */
export async function graphCounts(db: GraphClient): Promise<BackupCounts> {
  const labelRows = await db.query<{ labels: string[]; n: number }>("MATCH (n) RETURN labels(n) AS labels, count(n) AS n", {}, { readOnly: true, timeoutMs: 120_000 });
  const typeRows = await db.query<{ type: string; n: number }>("MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS n", {}, { readOnly: true, timeoutMs: 120_000 });
  const labels: Record<string, number> = {};
  let nodes = 0;
  for (const row of labelRows) {
    nodes += row.n;
    for (const l of row.labels) labels[l] = (labels[l] ?? 0) + row.n;
  }
  const types: Record<string, number> = {};
  let relationships = 0;
  for (const row of typeRows) {
    relationships += row.n;
    types[row.type] = (types[row.type] ?? 0) + row.n;
  }
  return { nodes, relationships, labels, types };
}

/** Differences between what a backup holds and what a graph holds, as readable lines; empty when they match. */
export function compareCounts(expected: BackupCounts, actual: BackupCounts): string[] {
  const problems: string[] = [];
  if (expected.nodes !== actual.nodes) problems.push(`nodes: expected ${expected.nodes}, found ${actual.nodes}`);
  if (expected.relationships !== actual.relationships) problems.push(`relationships: expected ${expected.relationships}, found ${actual.relationships}`);
  for (const key of new Set([...Object.keys(expected.labels), ...Object.keys(actual.labels)])) {
    if ((expected.labels[key] ?? 0) !== (actual.labels[key] ?? 0)) problems.push(`:${key}: expected ${expected.labels[key] ?? 0}, found ${actual.labels[key] ?? 0}`);
  }
  for (const key of new Set([...Object.keys(expected.types), ...Object.keys(actual.types)])) {
    if ((expected.types[key] ?? 0) !== (actual.types[key] ?? 0)) problems.push(`[:${key}]: expected ${expected.types[key] ?? 0}, found ${actual.types[key] ?? 0}`);
  }
  return problems;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Drop null values: neither database stores them, and Neo4j rejects maps holding them in SET +=. */
function clean(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

export interface RestoreOptions {
  /** Rows per statement (default 500). */
  batchSize?: number;
  /** Restore even if the graph already has nodes (they are kept; the backup is added beside them). */
  allowNonEmpty?: boolean;
  log?: (msg: string) => void;
}

/**
 * Rebuild a backup in an empty graph. Apply the schema first so the unique
 * constraints exist. Returns the counts it checked the result against.
 */
export async function restoreGraph(db: GraphClient, backup: GraphBackup, options: RestoreOptions = {}): Promise<BackupCounts> {
  const batch = options.batchSize ?? 500;
  const log = options.log ?? (() => {});
  if (!Array.isArray(backup.nodes) || !Array.isArray(backup.relationships)) throw new Error("Not a Trippr backup: nodes and relationships are missing");
  if ((backup.format ?? 1) > BACKUP_FORMAT) throw new Error(`This backup is format ${backup.format}; this version reads format ${BACKUP_FORMAT} and older`);

  const [existing] = await db.query<{ n: number }>("MATCH (n) RETURN count(n) AS n", {}, { readOnly: true });
  const before = existing?.n ?? 0;
  if (before > 0 && !options.allowNonEmpty) throw new Error(`The graph already has ${before} nodes; restore into an empty graph`);

  // Check every name before writing anything.
  for (const n of backup.nodes) n.labels.forEach(safeName);
  for (const r of backup.relationships) safeName(r.type);

  const index =
    db.dialect === "neo4j"
      ? { create: `CREATE INDEX restore_tmp IF NOT EXISTS FOR (n:${TMP_LABEL}) ON (n.${TMP_PROP})`, drop: "DROP INDEX restore_tmp IF EXISTS" }
      : { create: `CREATE INDEX FOR (n:${TMP_LABEL}) ON (n.${TMP_PROP})`, drop: `DROP INDEX FOR (n:${TMP_LABEL}) ON (n.${TMP_PROP})` };
  await db.query(index.create, {}, { timeoutMs: 60_000 });
  if (db.dialect === "neo4j") await db.query("CALL db.awaitIndexes(300)", {}, { timeoutMs: 310_000 });

  try {
    const byLabels = new Map<string, BackupNode[]>();
    for (const n of backup.nodes) {
      const key = [...n.labels].sort().join(":");
      const list = byLabels.get(key) ?? [];
      list.push(n);
      byLabels.set(key, list);
    }
    for (const [key, nodes] of byLabels) {
      const labels = [TMP_LABEL, ...(key ? key.split(":") : [])].join(":");
      for (const part of chunks(nodes, batch)) {
        await db.query(
          `UNWIND $rows AS row CREATE (n:${labels}) SET n += row.props, n.${TMP_PROP} = row.id`,
          { rows: part.map((n) => ({ id: n.id, props: clean(n.props) })) },
          { timeoutMs: 120_000 },
        );
      }
      log(`created ${nodes.length} ${key || "(no label)"} nodes`);
    }

    const byType = new Map<string, BackupRelationship[]>();
    for (const r of backup.relationships) {
      const list = byType.get(r.type) ?? [];
      list.push(r);
      byType.set(r.type, list);
    }
    for (const [type, rels] of byType) {
      for (const part of chunks(rels, batch)) {
        await db.query(
          `UNWIND $rows AS row
           MATCH (a:${TMP_LABEL} {${TMP_PROP}: row.s})
           MATCH (b:${TMP_LABEL} {${TMP_PROP}: row.e})
           CREATE (a)-[r:${type}]->(b) SET r += row.props`,
          { rows: part.map((r) => ({ s: r.start, e: r.end, props: clean(r.props) })) },
          { timeoutMs: 120_000 },
        );
      }
      log(`created ${rels.length} ${type} relationships`);
    }
  } finally {
    // Remove the scaffolding in batches, then the index, even after a failure, so a retry starts clean.
    for (;;) {
      const [row] = await db.query<{ n: number }>(
        `MATCH (n:${TMP_LABEL}) WITH n LIMIT 5000 REMOVE n:${TMP_LABEL} REMOVE n.${TMP_PROP} RETURN count(n) AS n`,
        {},
        { timeoutMs: 120_000 },
      );
      if (!row || row.n === 0) break;
    }
    await db.query(index.drop, {}, { timeoutMs: 60_000 }).catch(() => {});
  }

  const expected = backupCounts(backup);
  if (before === 0) {
    const problems = compareCounts(expected, await graphCounts(db));
    if (problems.length) throw new Error(`Restore finished but the graph does not match the backup:\n${problems.join("\n")}`);
  }
  return expected;
}

/**
 * Which dated backups to delete. Keeps every backup from the last `daily`
 * days, the newest backup of each of the last `weekly` weeks (Monday to
 * Sunday) and the newest of each of the last `monthly` months. Dates are
 * YYYY-MM-DD; anything else is never deleted.
 */
export function backupsToPrune(dates: string[], today: string, keep: { daily: number; weekly: number; monthly: number } = { daily: 14, weekly: 8, monthly: 12 }): string[] {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const day = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
  const t = day(today);
  const valid = [...new Set(dates.filter((d) => DATE.test(d) && Number.isFinite(day(d))))].sort().reverse();
  const keepSet = new Set<string>();
  const weeks = new Set<number>();
  const months = new Set<string>();
  for (const d of valid) {
    const age = t - day(d);
    // Monday-based week number: day 0 (1970-01-01) was a Thursday.
    const week = Math.floor((day(d) + 3) / 7);
    const weekAge = Math.floor((t + 3) / 7) - week;
    const month = d.slice(0, 7);
    const monthAge = (Number(today.slice(0, 4)) - Number(d.slice(0, 4))) * 12 + (Number(today.slice(5, 7)) - Number(d.slice(5, 7)));
    // Newest first, so the first backup seen in a week or month is the one that stands for it.
    const keepIt =
      age < 0 ||
      age < keep.daily ||
      (weekAge < keep.weekly && !weeks.has(week)) ||
      (monthAge < keep.monthly && !months.has(month));
    if (keepIt) {
      keepSet.add(d);
      weeks.add(week);
      months.add(month);
    }
  }
  return valid.filter((d) => !keepSet.has(d)).sort();
}
