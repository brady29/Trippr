import { createHash } from "node:crypto";
import { modelFamily } from "@trippr/contracts";

/**
 * Turns a short question into a vector, with the same model that embedded the places (docs/embeddings-spike.md:
 * place vectors are made on a laptop, only the query is embedded here). Adapters:
 *  - Cloudflare Workers AI, `@cf/baai/bge-m3`, configured only when CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are set;
 *  - a fake, deterministic one for tests and the end-to-end run (SEARCH_EMBEDDER=fake);
 *  - later, the owner's own tiny Cloud Run service behind the same interface.
 * Nothing here holds a key in a file; the API token is read from the environment by the caller and kept in a closure.
 */
export interface QueryEmbedder {
  /** For logs and the health line: "cloudflare:@cf/baai/bge-m3", "fake-64". */
  readonly name: string;
  /** Can this embedder's vectors be compared with the loaded place vectors? A reason when not. */
  compatible(loaded: { model: string; dims: number }): { ok: true } | { ok: false; reason: string };
  /** One unit-length vector. Rejects on timeout (`signal`), HTTP errors and malformed answers. */
  embed(text: string, signal?: AbortSignal): Promise<Float32Array>;
}

/** The embedder failed in a way worth showing as "words only" rather than an error page. */
export class EmbedError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EmbedError";
  }
}

export function normalise(vector: ArrayLike<number>): Float32Array {
  const out = new Float32Array(vector.length);
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i]!;
    if (!Number.isFinite(v)) throw new EmbedError("The embedder returned a vector with a value that is not a number");
    out[i] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) throw new EmbedError("The embedder returned a zero vector");
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  return out;
}

// --- Cloudflare Workers AI -------------------------------------------------------------------------

export interface CloudflareOptions {
  accountId: string;
  apiToken: string;
  /** Default `@cf/baai/bge-m3` (1024 dimensions). */
  model?: string;
  /** Replaced in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  baseUrl?: string;
}

export const CLOUDFLARE_MODELS: Record<string, { family: string; dims: number }> = {
  "@cf/baai/bge-m3": { family: "bge-m3", dims: 1024 },
};

/**
 * POST https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/@cf/baai/bge-m3 with {"text": ["..."]}
 * answers {"result": {"shape": [1, 1024], "data": [[...]]}, "success": true, "errors": [], "messages": []}.
 * That shape is from Cloudflare's documentation and a stubbed test: it has NOT been run against the real service
 * (no account exists yet). `pipelines/eval/search/parity_check.py` is the check to run once the token is set.
 */
export function createCloudflareEmbedder(options: CloudflareOptions): QueryEmbedder {
  const model = options.model ?? "@cf/baai/bge-m3";
  const known = CLOUDFLARE_MODELS[model];
  if (!known) throw new Error(`Unknown Cloudflare embedding model ${model}. Known: ${Object.keys(CLOUDFLARE_MODELS).join(", ")}`);
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseUrl ?? "https://api.cloudflare.com"}/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/run/${model}`;
  const { apiToken } = options;
  return {
    name: `cloudflare:${model}`,
    compatible(loaded) {
      if (modelFamily(loaded.model) !== known.family) {
        return { ok: false, reason: `The loaded vectors are from ${loaded.model}, but Cloudflare serves ${known.family} here` };
      }
      if (loaded.dims !== known.dims) return { ok: false, reason: `The loaded vectors have ${loaded.dims} dimensions, ${model} makes ${known.dims}` };
      return { ok: true };
    },
    async embed(text, signal) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
          body: JSON.stringify({ text: [text] }),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        // Never echo the request: the error text must not carry the token.
        throw new EmbedError(error instanceof Error && error.name === "AbortError" ? "The embedder did not answer in time" : "The embedder could not be reached");
      }
      if (!res.ok) throw new EmbedError(`The embedder answered HTTP ${res.status}`, res.status);
      let body: { success?: boolean; result?: { data?: unknown } };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new EmbedError("The embedder's answer was not JSON");
      }
      const data = body.result?.data;
      const row = Array.isArray(data) ? (data[0] as unknown) : undefined;
      if (body.success === false || !Array.isArray(row)) throw new EmbedError("The embedder's answer had no vector");
      if (row.length !== known.dims) throw new EmbedError(`The embedder returned ${row.length} values, expected ${known.dims}`);
      return normalise(row as number[]);
    },
  };
}

// --- the fake -------------------------------------------------------------------------------------

/**
 * Hashed character 1 to 3-gram counts, normalised: deterministic and lexically meaningful (similar words give
 * similar vectors), which is all a test needs. It is not a language model and says nothing about search quality.
 * The same function embeds the test places (see the test kit), so queries and places live in one space.
 */
export function fakeVector(text: string, dims: number): Float32Array {
  const vec = new Float32Array(dims);
  for (const token of text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const padded = `^${token}$`;
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= padded.length; i++) {
        const digest = createHash("sha256").update(padded.slice(i, i + n)).digest();
        const slot = digest.readUInt32LE(0) % dims;
        vec[slot] = vec[slot]! + (digest[4]! & 1 ? 1 : -1) * Math.sqrt(n);
      }
    }
  }
  // An empty text still gets a vector, so a query of punctuation does not crash a test.
  if (vec.every((v) => v === 0)) vec[0] = 1;
  return normalise(vec);
}

export function createFakeEmbedder(dims = 64): QueryEmbedder & { calls: string[]; failWith?: Error; delayMs?: number } {
  const embedder = {
    name: `fake-${dims}`,
    calls: [] as string[],
    failWith: undefined as Error | undefined,
    delayMs: undefined as number | undefined,
    compatible(loaded: { model: string; dims: number }) {
      if (!loaded.model.startsWith("fake")) return { ok: false as const, reason: `The loaded vectors are from ${loaded.model}, not the fake test model` };
      if (loaded.dims !== dims) return { ok: false as const, reason: `The loaded vectors have ${loaded.dims} dimensions, the fake embedder makes ${dims}` };
      return { ok: true as const };
    },
    async embed(text: string, signal?: AbortSignal) {
      embedder.calls.push(text);
      if (embedder.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, embedder.delayMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new EmbedError("The embedder did not answer in time"));
          });
        });
      }
      if (embedder.failWith) throw embedder.failWith;
      return fakeVector(text, dims);
    },
  };
  return embedder;
}

// --- choosing one from the environment ------------------------------------------------------------

export interface EmbedderConfig {
  SEARCH_EMBEDDER?: "cloudflare" | "fake" | "off" | undefined;
  SEARCH_FAKE_DIMS: number;
  CLOUDFLARE_ACCOUNT_ID?: string | undefined;
  CLOUDFLARE_API_TOKEN?: string | undefined;
  CLOUDFLARE_EMBED_MODEL: string;
}

/**
 * Unset SEARCH_EMBEDDER: Cloudflare when both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are set, otherwise none,
 * and search runs on words only. "fake" is for tests and the end-to-end run, never production.
 */
export function embedderFromConfig(config: EmbedderConfig, fetchImpl?: typeof fetch): QueryEmbedder | null {
  const choice = config.SEARCH_EMBEDDER ?? (config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_API_TOKEN ? "cloudflare" : "off");
  if (choice === "off") return null;
  if (choice === "fake") return createFakeEmbedder(config.SEARCH_FAKE_DIMS);
  if (!config.CLOUDFLARE_ACCOUNT_ID || !config.CLOUDFLARE_API_TOKEN) {
    throw new Error("SEARCH_EMBEDDER=cloudflare needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment");
  }
  return createCloudflareEmbedder({
    accountId: config.CLOUDFLARE_ACCOUNT_ID,
    apiToken: config.CLOUDFLARE_API_TOKEN,
    model: config.CLOUDFLARE_EMBED_MODEL,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
