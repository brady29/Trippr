import type { EmbeddingIndexInfo } from "@trippr/contracts";
import type { GraphClient } from "../db/graph";
import { cypher } from "./queries";
import { num, optNum } from "./util";

/** The fields the ranking reads about a candidate. Never the vector. */
export interface SearchCandidate {
  id: string;
  title: string;
  nameLocal: string | null;
  address: string | null;
  category: string | null;
  lat: number | null;
  lon: number | null;
  rank: number | null;
  cityCode: string;
  cityName: string;
  tags: string[];
}

export interface CandidateFilters {
  cityCode?: string | undefined;
  tag?: string | undefined;
  category?: string | undefined;
}

/** One place's vector with the metadata the exact search filters on. */
export interface VectorRow {
  id: string;
  cityCode: string;
  category: string | null;
  lat: number | null;
  lon: number | null;
  tags: string[];
  vector: number[];
}

export interface IndexState extends EmbeddingIndexInfo {
  /** Changes whenever the load job wrote vectors; the in-memory matrix reloads when it moves. */
  revision: string;
}

export interface EmbeddingRow {
  activityId: string;
  hash: string;
  vector: ArrayLike<number>;
}

/** The vector path of FalkorDB reports a distance, Neo4j's a 0..1 similarity; both become cosine similarity here. */
export type NearestRow = { id: string; similarity: number };

const BATCH = 50; // 50 vectors of 1,024 floats is about 0.5 MB of query text for FalkorDB, which inlines parameters

type CandidateRow = Omit<SearchCandidate, "lat" | "lon" | "rank" | "tags" | "nameLocal" | "address" | "category"> & {
  nameLocal: string | null;
  address: string | null;
  category: string | null;
  lat: unknown;
  lon: unknown;
  rank: unknown;
  tags: string[] | null;
};

const toCandidate = (r: CandidateRow): SearchCandidate => ({
  id: r.id,
  title: r.title,
  nameLocal: r.nameLocal ?? null,
  address: r.address ?? null,
  category: r.category ?? null,
  lat: optNum(r.lat),
  lon: optNum(r.lon),
  rank: optNum(r.rank),
  cityCode: r.cityCode,
  cityName: r.cityName,
  tags: [...(r.tags ?? [])],
});

/**
 * Everything semantic search does to the graph: the vector index, the vectors on Activity nodes, the one
 * EmbeddingIndex node that says what they are, and the candidate reads. The vector is read in one query
 * (vectors-page, for the exact search) and written in one (embedding-write); no other query returns it.
 */
export function searchRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const read = { readOnly: true };
  const filtersOf = (f: CandidateFilters) => ({ cityCode: f.cityCode ?? null, tag: f.tag ?? null, category: f.category ?? null });

  return {
    /** What the loaded vectors are, or null before the first load. */
    async indexState(): Promise<IndexState | null> {
      const [row] = await db.query<Record<string, unknown>>(q("search/index-info"), {}, read);
      if (!row) return null;
      return {
        model: String(row.model),
        version: String(row.version),
        dims: num(row.dims),
        textVersion: String(row.textVersion),
        count: num(row.count),
        bundleDate: String(row.bundleDate),
        loadedAt: String(row.loadedAt),
        revision: String(row.revision),
      };
    },

    async setIndexState(state: IndexState) {
      await db.query(q("search/index-set"), { ...state });
    },

    async forgetIndexState() {
      await db.query(q("search/index-forget"));
    },

    /** Create the vector index for this dimension. Idempotent: an index that already exists is fine. */
    async ensureVectorIndex(dims: number) {
      if (!Number.isInteger(dims) || dims < 1 || dims > 4096) throw new Error(`Not a vector size: ${dims}`);
      const statement = q("search/index-create").replace(/__DIMENSIONS__/g, String(dims));
      try {
        await db.query(statement);
      } catch (error) {
        // FalkorDB has no IF NOT EXISTS; the message for a second run says the attribute is already indexed.
        if (error instanceof Error && /already indexed|already exists|equivalent index/i.test(error.message)) return;
        throw new Error(`Creating the ${db.dialect} vector index failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async dropVectorIndex() {
      try {
        await db.query(q("search/index-drop"));
      } catch (error) {
        // Nothing to drop is the state we want.
        if (error instanceof Error && /no such index|not indexed|does not exist|unable to drop|not found/i.test(error.message)) return;
        throw error;
      }
    },

    /** Neo4j builds the index in the background; FalkorDB has nothing to wait for. */
    async awaitVectorIndex() {
      await db.query(q("search/index-await"));
    },

    /** Place id -> the activity that is that place and the hash of the vector it carries (null: none). */
    async embeddingState(): Promise<{ placeId: string; id: string; hash: string | null }[]> {
      const rows = await db.query<{ placeId: string; id: string; hash: string | null }>(q("search/embedding-state"), {}, read);
      return rows.map((r) => ({ placeId: r.placeId, id: r.id, hash: r.hash ?? null }));
    },

    async writeEmbeddings(rows: EmbeddingRow[]): Promise<number> {
      let written = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH).map((r) => ({ activityId: r.activityId, hash: r.hash, vector: Array.from(r.vector) }));
        const [row] = await db.query<{ written: unknown }>(q("search/embedding-write"), { rows: batch });
        written += num(row?.written);
      }
      return written;
    },

    async clearEmbeddings(): Promise<number> {
      const [row] = await db.query<{ cleared: unknown }>(q("search/embedding-clear"));
      return num(row?.cleared);
    },

    /** The k nearest activities by the database's vector index, as cosine similarity, best first. */
    async nearest(vector: ArrayLike<number>, k: number): Promise<NearestRow[]> {
      const rows = await db.query<{ id: string; score: unknown }>(q("search/nearest"), { vector: Array.from(vector), k }, read);
      return rows.map((r) => ({ id: r.id, similarity: scoreToSimilarity(db.dialect, num(r.score)) }));
    },

    /** A page of vectors in id order after `after` (empty string: from the start), for the exact search. */
    async vectorsPage(after: string, limit: number): Promise<VectorRow[]> {
      const rows = await db.query<Omit<VectorRow, "vector" | "lat" | "lon"> & { vector: unknown; lat: unknown; lon: unknown }>(
        q("search/vectors-page"),
        { after, limit },
        read,
      );
      return rows.map((r) => ({
        id: r.id,
        cityCode: r.cityCode,
        category: r.category ?? null,
        lat: optNum(r.lat),
        lon: optNum(r.lon),
        tags: [...(r.tags ?? [])],
        vector: Array.isArray(r.vector) ? (r.vector as number[]) : [],
      }));
    },

    /** Details and filter checks for activities of this trip by id (the vector candidates). */
    async candidates(tripId: string, ids: string[], filters: CandidateFilters): Promise<SearchCandidate[]> {
      if (!ids.length) return [];
      const rows = await db.query<CandidateRow>(q("search/candidates"), { tripId, ids, ...filtersOf(filters) }, read);
      return rows.map(toCandidate);
    },

    /** Activities that contain any of the lower-case tokens in a name, address, category or city name. */
    async lexical(tripId: string, tokens: string[], filters: CandidateFilters, cap: number): Promise<SearchCandidate[]> {
      if (!tokens.length) return [];
      const rows = await db.query<CandidateRow>(q("search/lexical"), { tripId, tokens, cap, ...filtersOf(filters) }, read);
      return rows.map(toCandidate);
    },
  };
}

export type SearchRepository = ReturnType<typeof searchRepository>;

/**
 * Cosine similarity from what each database's vector index calls a score.
 * FalkorDB returns the cosine distance (1 - cosine; 0 is identical), Neo4j (1 + cosine) / 2.
 * integration test "the vector index" checks both against an exact cosine, so a change in either database's
 * convention fails there with the numbers, not as a silent change in ranking.
 */
export function scoreToSimilarity(dialect: GraphClient["dialect"], score: number): number {
  return dialect === "falkordb" ? 1 - score : 2 * score - 1;
}
