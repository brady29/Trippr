import { z } from "zod";
import type { LibraryActivity } from "./dto";
import { cityCode } from "./schemas";

/**
 * Semantic search (docs/data-platform-spec.md, Feature 4): the embeddings run the pipeline writes
 * (pipelines/src/trippr_data/embed/run.py), the request and response of GET /trips/:id/search, and the
 * summary the Data page shows. The run's files use snake_case, like the pipeline's Parquet.
 */

// --- the embeddings run: embeddings/<date>/ -------------------------------------------------------

export const EMBEDDINGS_MANIFEST_FILE = "manifest.json";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** `manifest.json` of an embed run. Unknown fields are kept (the pipeline adds timings and cache counts). */
export const embeddingsManifestSchema = z
  .object({
    stage: z.literal("embed"),
    /** As the pipeline names it: "bge-m3-q8", "multilingual-e5-small", "fake-128". */
    model: z.string().min(1),
    /** The exact weights, e.g. "Xenova/bge-m3/onnx/model_quantized.onnx@4e6b8f1c2d3a". */
    version: z.string(),
    dims: z.number().int().min(1).max(4096),
    normalized: z.literal(true),
    similarity: z.literal("cosine"),
    text_version: z.string(),
    count: z.number().int().min(0),
    created_at: z.string(),
    /** The Parquet the pipeline's own tools read. The load job reads the sidecar below instead. */
    vectors_file: z.string(),
    vectors_sha256: sha256Hex,
    /** Raw little-endian float32, count x dims, rows in the order of the ids file. */
    matrix_file: z.string().min(1),
    matrix_sha256: sha256Hex,
    /** JSON, see embeddingsIdsSchema. */
    ids_file: z.string().min(1),
    ids_sha256: sha256Hex,
  })
  .passthrough();
export type EmbeddingsManifest = z.infer<typeof embeddingsManifestSchema>;

export const embeddingsIdsSchema = z.object({ place_ids: z.array(z.string().min(1)), content_hashes: z.array(z.string().min(1)) }).strict();

/** "bge-m3-q8" and "bge-m3" are the same model (an 8-bit build of it): vectors from either match queries from either. */
export const modelFamily = (model: string) => model.replace(/-q8$/, "");

// --- the search request ---------------------------------------------------------------------------

export const SEARCH_QUERY_MAX = 200;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_LIMIT_DEFAULT = 20;

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());

const latLon = z
  .string()
  .trim()
  .regex(/^-?\d{1,3}(\.\d+)?,\s*-?\d{1,3}(\.\d+)?$/, "Use lat,lon like 34.67,135.5")
  .transform((s) => {
    const [lat, lon] = s.split(",").map((n) => Number(n.trim())) as [number, number];
    return { lat, lon };
  })
  .refine((p) => Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180, "Latitude is within 90 and longitude within 180");

/**
 * GET /trips/:id/search?q=&city=&tag=&category=&near=lat,lon&km=&limit=
 * Everything but `q` is optional. `km` only means something with `near`.
 */
export const searchQuery = z
  .object({
    q: z.string().trim().min(1, "Say what you are looking for").max(SEARCH_QUERY_MAX),
    city: optional(cityCode),
    /** The app's colour tag: sport, tech, nature, culture, food. */
    tag: optional(z.string().trim().toLowerCase().max(24)),
    /** A catalogue category from the taxonomy, e.g. "viewpoint". */
    category: optional(z.string().trim().max(40)),
    near: optional(latLon),
    km: optional(z.coerce.number().min(0.1).max(100)),
    limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).default(SEARCH_LIMIT_DEFAULT),
  })
  .transform((v) => ({ ...v, km: v.near ? (v.km ?? 5) : undefined }));
export type SearchParams = z.output<typeof searchQuery>;
/** What a client sends. */
export interface SearchRequest {
  q: string;
  city?: string;
  tag?: string;
  category?: string;
  near?: string;
  km?: number;
  limit?: number;
}

// --- the response ---------------------------------------------------------------------------------

/** Why a place is in the results: its meaning is close, its name matches the words, or both. */
export type SearchMatch = "meaning" | "name" | "both" | "words";

export interface SearchHit {
  /** The same card the Activities page shows (votes, tags, plans, sources with licences). */
  activity: LibraryActivity;
  /** Ranking score, 0 to about 1. Only meaningful within one response. */
  score: number;
  /** Cosine similarity to the question (-1 to 1); null when the vectors did not rank this place. */
  similarity: number | null;
  /** How well the words match the name, local name or address (0 to 1). */
  lexical: number;
  match: SearchMatch;
  /** A short sentence for the result: "Similar in meaning to your search", "Name matches ...". */
  reason: string;
  distanceKm: number | null;
}

export type SearchNoticeCode =
  /** No query embedder is configured here, or the loaded vectors came from another model. */
  | "no_embedder"
  /** The embedder did not answer in time or errored; this answer is words only. */
  | "embedder_unavailable"
  /** This member used today's allowance of meaning-based searches. */
  | "daily_limit"
  /** The catalogue has no vectors loaded yet. */
  | "no_vectors"
  /** The query embedder serves a different model or size than the loaded vectors. */
  | "model_mismatch"
  /** The vectors could not be searched (the index and the exact scan both failed); words only. */
  | "vectors_unavailable"
  /** The read-only demo account does not call the hosted embedder. */
  | "demo";

export interface SearchNotice {
  code: SearchNoticeCode;
  message: string;
}

export interface SearchResponse {
  query: string;
  /** hybrid: vectors and words; lexical: words only (see `notice`). */
  mode: "hybrid" | "lexical";
  notice: SearchNotice | null;
  /** Which vector path ranked the candidates: the database's vector index or an exact scan; null in lexical mode. */
  engine: "index" | "exact" | null;
  hits: SearchHit[];
  /** True when filters left fewer than asked after the database's nearest-neighbour list was filtered. */
  truncated: boolean;
}

/** What the loaded vectors are (the Data page and the search service read this). */
export interface EmbeddingIndexInfo {
  model: string;
  version: string;
  dims: number;
  textVersion: string;
  /** Activities with a vector. */
  count: number;
  bundleDate: string;
  loadedAt: string;
}
