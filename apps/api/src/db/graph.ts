export type Dialect = "falkordb" | "neo4j";

export type Params = Record<string, unknown>;

export interface QueryOptions {
  /** Route the query to a read-only path (replica / read transaction). */
  readOnly?: boolean;
  timeoutMs?: number;
}

/**
 * The only thing repositories know about the database. Each adapter turns
 * rows into plain JavaScript objects keyed by column name, with integers as
 * numbers, so the repository code is identical for FalkorDB and Neo4j.
 */
export interface GraphClient {
  readonly dialect: Dialect;
  query<T = Record<string, unknown>>(cypher: string, params?: Params, options?: QueryOptions): Promise<T[]>;
  /** Runs one trivial query; used by /health. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Schema operations are not portable Cypher, so each adapter implements them. */
export interface SchemaAdmin {
  /** Run one statement from db/schema/<dialect>.cypher. */
  applySchemaStatement(statement: string): Promise<void>;
  /** Delete every node and relationship (tests and `db:reset` only). */
  dropAll(): Promise<void>;
}

export type AdminGraphClient = GraphClient & SchemaAdmin;
