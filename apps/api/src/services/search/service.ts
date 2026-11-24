import type { SearchHit, SearchNotice, SearchParams, SearchResponse } from "@trippr/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../../config";
import type { Repositories } from "../../repositories";
import type { CandidateFilters, IndexState, SearchCandidate } from "../../repositories/search";
import { EmbedError, embedderFromConfig, type QueryEmbedder } from "./embedder";
import { Breaker, QueryCache, SearchGovernor } from "./governor";
import { MatrixCache, type MatrixFilter } from "./matrix";
import { byScore, combine, dbTokens, fold, haversineKm, lexicalScore, worthShowing, type Scored } from "./ranking";

/** How long a failed index query keeps the exact path in front (SEARCH_VECTOR_PATH=auto). */
const INDEX_COOL_OFF_MS = 5 * 60_000;
/** The most rows the words-only query returns for ranking. */
const LEXICAL_CAP = 400;
/** How long the "what are the loaded vectors" answer is reused; a new load shows up within this. */
const STATE_TTL_MS = 10_000;

export interface SearchDeps {
  repos: Repositories;
  config: Pick<
    Config,
    | "SEARCH_EMBEDDER"
    | "SEARCH_FAKE_DIMS"
    | "CLOUDFLARE_ACCOUNT_ID"
    | "CLOUDFLARE_API_TOKEN"
    | "CLOUDFLARE_EMBED_MODEL"
    | "SEARCH_EMBED_TIMEOUT_MS"
    | "SEARCH_VECTOR_PATH"
    | "SEARCH_RATE_PER_MINUTE"
    | "SEARCH_DAILY_LIMIT"
  >;
  log: Pick<FastifyBaseLogger, "warn" | "info">;
  /** Tests pass one (or null for "none"); otherwise it comes from the configuration. */
  embedder?: QueryEmbedder | null | undefined;
  now?: () => number;
  stateTtlMs?: number;
}

export interface SearchCaller {
  id: string;
  isDemo: boolean;
}

export type Search = ReturnType<typeof createSearch>;

const notice = (code: SearchNotice["code"], message: string): SearchNotice => ({ code, message });

/**
 * Hybrid search over the trip's activities: the question is embedded (one hosted call, cached), the nearest places
 * come from the database's vector index or an exact in-memory scan, the words are matched in the database, and the
 * two lists are scored together. Without an embedder, vectors or allowance it answers on words alone and says why.
 */
export function createSearch(deps: SearchDeps) {
  const { repos, config, log } = deps;
  const now = deps.now ?? Date.now;
  const embedder = deps.embedder !== undefined ? deps.embedder : embedderFromConfig(config);
  const governor = new SearchGovernor({ perMinute: config.SEARCH_RATE_PER_MINUTE, dailyEmbeds: config.SEARCH_DAILY_LIMIT, now });
  const breaker = new Breaker(3, 30_000, now);
  const cache = new QueryCache<Float32Array>();
  const matrices = new MatrixCache(repos.search);
  let indexBrokenUntil = 0;
  let stateCache: { at: number; value: IndexState | null } | null = null;

  async function indexState(): Promise<IndexState | null> {
    const ttl = deps.stateTtlMs ?? STATE_TTL_MS;
    if (stateCache && now() - stateCache.at < ttl) return stateCache.value;
    const value = await repos.search.indexState();
    stateCache = { at: now(), value };
    return value;
  }

  /** The question as a vector, or why not. Uses the cache first, then the allowance, then the hosted call. */
  async function embed(text: string, caller: SearchCaller): Promise<{ vector: Float32Array } | { notice: SearchNotice }> {
    if (!embedder) return { notice: notice("no_embedder", "Search is matching words only: meaning-based search is not set up on this server.") };
    const key = fold(text).trim();
    const cached = cache.get(key);
    if (cached) return { vector: cached };
    if (caller.isDemo) return { notice: notice("demo", "Search is matching words only for the demo account; meaning-based search is for signed-in members.") };
    if (governor.embedsLeft(caller.id) <= 0) {
      return {
        notice: notice("daily_limit", `You have used today's ${governor.dailyLimit} meaning-based searches. Searching by words still works; the allowance resets at midnight UTC.`),
      };
    }
    const unavailable = notice("embedder_unavailable", "Meaning-based search did not answer, so this is matching words only. Try again in a moment.");
    if (breaker.open) return { notice: unavailable };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.SEARCH_EMBED_TIMEOUT_MS);
    governor.countEmbed(caller.id);
    try {
      const vector = await embedder.embed(text, controller.signal);
      breaker.success();
      cache.set(key, vector);
      return { vector };
    } catch (error) {
      breaker.failure();
      // The message is ours (EmbedError never carries the request or the token); anything else is logged by name only.
      log.warn({ embedder: embedder.name, error: error instanceof EmbedError ? error.message : String((error as Error)?.name ?? "error") }, "query embedding failed");
      return { notice: unavailable };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Nearest places by vector: exact when the filters make the index a poor fit, the index otherwise. */
  async function nearest(
    vector: Float32Array,
    state: IndexState,
    params: SearchParams,
    wanted: number,
  ): Promise<{ rows: { id: string; similarity: number }[]; engine: "index" | "exact"; k: number } | null> {
    const filtered = Boolean(params.city || params.tag || params.category || params.near);
    const preference = config.SEARCH_VECTOR_PATH;
    const exactFirst = preference === "exact" || (preference === "auto" && (filtered || now() < indexBrokenUntil));
    const k = exactFirst ? Math.min(300, Math.max(30, wanted * 3)) : filtered ? Math.min(500, wanted * 10) : Math.min(200, Math.max(30, wanted * 4));

    const exact = async () => {
      const matrix = await matrices.get(state);
      const filter: MatrixFilter = {
        cityCode: params.city,
        category: params.category,
        tag: params.tag,
        near: params.near ? { ...params.near, km: params.km ?? 5 } : undefined,
      };
      return { rows: matrix.nearest(vector, k, filter), engine: "exact" as const, k };
    };
    const index = async () => ({ rows: await repos.search.nearest(vector, k), engine: "index" as const, k });

    try {
      const answer = await (exactFirst ? exact() : index());
      // An index that answers nothing although vectors are loaded is a broken index (dropped, or still empty).
      if (!exactFirst && preference === "auto" && answer.rows.length === 0 && state.count > 0) throw new Error("the vector index returned no rows");
      return answer;
    } catch (first) {
      log.warn({ path: exactFirst ? "exact" : "index", error: first instanceof Error ? first.message : String(first) }, "vector search failed");
      if (preference !== "auto") return null;
      // auto: the other path gets a turn; a broken index stays out of the way for a while.
      if (!exactFirst) indexBrokenUntil = now() + INDEX_COOL_OFF_MS;
      try {
        return await (exactFirst ? index() : exact());
      } catch (second) {
        log.warn({ error: second instanceof Error ? second.message : String(second) }, "both vector paths failed");
        return null;
      }
    }
  }

  async function run(caller: SearchCaller, tripId: string, params: SearchParams): Promise<SearchResponse> {
    const filters: CandidateFilters = { cityCode: params.city, tag: params.tag, category: params.category };
    const state = await indexState();

    let vector: Float32Array | null = null;
    let why: SearchNotice | null = null;
    if (!embedder) why = notice("no_embedder", "Search is matching words only: meaning-based search is not set up on this server.");
    else if (!state || state.count === 0) why = notice("no_vectors", "Search is matching words only: no place vectors have been loaded yet.");
    else {
      const fit = embedder.compatible(state);
      if (!fit.ok) why = notice("model_mismatch", `Search is matching words only: ${fit.reason}.`);
      else {
        const result = await embed(params.q, caller);
        if ("vector" in result) vector = result.vector;
        else why = result.notice;
      }
    }

    let engine: SearchResponse["engine"] = null;
    let truncated = false;
    const similarity = new Map<string, number>();
    let vectorIds: string[] = [];
    let vectorK = 0;
    if (vector && state) {
      const found = await nearest(vector, state, params, params.limit);
      if (found) {
        engine = found.engine;
        vectorK = found.k;
        vectorIds = found.rows.map((r) => r.id);
        for (const r of found.rows) similarity.set(r.id, r.similarity);
      } else {
        vector = null;
        why = notice("vectors_unavailable", "Meaning-based search could not be reached, so this is matching words only.");
      }
    }

    const [fromVectors, fromWords] = await Promise.all([
      vectorIds.length ? repos.search.candidates(tripId, vectorIds, filters) : Promise.resolve<SearchCandidate[]>([]),
      repos.search.lexical(tripId, dbTokens(params.q), filters, LEXICAL_CAP),
    ]);
    const candidates = new Map<string, SearchCandidate>();
    for (const c of [...fromVectors, ...fromWords]) candidates.set(c.id, c);

    // An exact scan can say how similar a words-only match is as well; the database's index cannot.
    if (vector && engine === "exact" && state) {
      const matrix = await matrices.get(state);
      for (const id of candidates.keys()) {
        if (!similarity.has(id)) {
          const s = matrix.similarity(vector, id);
          if (s != null) similarity.set(id, s);
        }
      }
    }

    const scored: Scored[] = [];
    for (const c of candidates.values()) {
      let distanceKm: number | null = null;
      if (params.near) {
        if (c.lat == null || c.lon == null) continue;
        distanceKm = haversineKm(params.near, { lat: c.lat, lon: c.lon });
        if (distanceKm > (params.km ?? 5)) continue;
      }
      const s = combine(c, { similarity: similarity.get(c.id) ?? null, lexical: lexicalScore(params.q, c), distanceKm }, vector !== null);
      if (worthShowing(s, vector !== null)) scored.push(s);
    }
    scored.sort(byScore);
    const top = scored.slice(0, params.limit);
    truncated = engine === "index" && Boolean(params.city || params.tag || params.category) && fromVectors.length < params.limit && vectorIds.length >= vectorK;

    const cards = top.length ? await repos.activities.list(tripId, caller.id, { ids: top.map((s) => s.candidate.id) }) : [];
    const byId = new Map(cards.map((a) => [a.id, a]));
    const hits: SearchHit[] = [];
    for (const s of top) {
      const activity = byId.get(s.candidate.id);
      if (!activity) continue;
      hits.push({
        activity,
        score: Math.round(s.score * 1000) / 1000,
        similarity: s.similarity == null ? null : Math.round(s.similarity * 1000) / 1000,
        lexical: Math.round(s.lexical * 1000) / 1000,
        match: s.match,
        reason: s.reason,
        distanceKm: s.distanceKm == null ? null : Math.round(s.distanceKm * 10) / 10,
      });
    }
    return { query: params.q, mode: vector ? "hybrid" : "lexical", notice: vector ? null : why, engine, hits, truncated };
  }

  return {
    /** Is there a query embedder at all (the Data page and the health line say so). */
    embedderName: embedder?.name ?? null,
    governor,
    /** What the loaded vectors are; null before the first load. */
    info: indexState,
    run,
    /** Forget the cached state (tests; and the load job calls the repository directly). */
    reset() {
      stateCache = null;
      matrices.clear();
      indexBrokenUntil = 0;
    },
    get matrixBytes() {
      return matrices.bytes;
    },
  };
}
