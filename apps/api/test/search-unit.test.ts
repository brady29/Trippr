import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchQuery, type LibraryActivity, type SearchResponse } from "@trippr/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Repositories } from "../src/repositories";
import type { IndexState, SearchCandidate } from "../src/repositories/search";
import { scoreToSimilarity } from "../src/repositories/search";
import { Seen, trimSearch } from "../src/services/assistant/helpers";
import { prepareTool, type ToolContext } from "../src/services/assistant/tools";
import { localStore } from "../src/services/catalogue/bundle";
import { checkCoverage, conflictWith, defaultEmbeddingsLocation, readEmbeddingsRun } from "../src/services/catalogue/embeddings";
import { createCloudflareEmbedder, createFakeEmbedder, EmbedError, embedderFromConfig, fakeVector } from "../src/services/search/embedder";
import { writeFakeRun } from "../src/services/search/fake-run";
import { Breaker, QueryCache, SearchGovernor } from "../src/services/search/governor";
import { buildMatrix, MatrixCache } from "../src/services/search/matrix";
import { renderMarkdown, scoreQuery, summarise } from "../src/services/search/metrics";
import { combine, dbTokens, haversineKm, lexicalScore, tokens, WEIGHTS } from "../src/services/search/ranking";
import { createSearch } from "../src/services/search/service";
import { GOLDEN_BUNDLE_DIR, place, tempBundleRoot, writeBundle } from "./bundle-kit";
import { P, PLACES } from "./search-fixtures";
import type { ExistingActivity } from "../src/repositories/catalogue";
import { readBundle, selectBundle } from "../src/services/catalogue/bundle";
import { planLoad } from "../src/services/catalogue/loader";

// No database in this file: everything here is pure or runs against stand-ins.

const cand = (over: Partial<SearchCandidate> & { id: string; title: string }): SearchCandidate => ({
  nameLocal: null,
  address: null,
  category: null,
  lat: null,
  lon: null,
  rank: null,
  cityCode: "KYO",
  cityName: "Kyoto",
  tags: [],
  ...over,
});

/** The seed's hand-written activities as the load job sees them in a freshly seeded graph. */
function seededActivities(): ExistingActivity[] {
  const seed = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "../../../seed", name), "utf8")) as unknown;
  const cities = new Map((seed("cities.json") as { code: string; name: string }[]).map((c) => [c.code, c.name]));
  return (seed("activities.json") as { id: string; city: string; title: string; mapsQuery?: string }[]).map((a) => ({
    id: a.id, title: a.title, mapsQuery: a.mapsQuery ?? null, lat: null, lon: null, placeStatus: "unplaced", geoSource: null,
    catalogue: false, adopted: false, catalogueId: null, sourceKeys: [], listed: true, hidden: false, edited: false, contentHash: null,
    cityCode: a.city, cityName: cities.get(a.city) ?? a.city, votes: 0, plans: 0, comments: 0,
  }));
}

describe("the test fixtures and the seed", () => {
  it("never adopts a fixture place into a hand-written activity (an adopted place has the idea's id, not its own)", async () => {
    const root = tempBundleRoot();
    writeBundle(root, { date: "2026-11-24", places: PLACES });
    const bundle = await readBundle(localStore(root), "2026-11-24");
    const plan = planLoad(seededActivities(), bundle, "2026-11-24T00:00:00Z");
    const taken = plan.adopted.map((a) => `${a.placeId} adopted by ${a.activityId} (${a.title})`);
    expect(taken, "rename the fixture place or move it: the seed already has an activity with that name in that city").toEqual([]);
    expect(plan.create.map((r) => r.id).sort()).toEqual(PLACES.map((p) => p.id).sort());
    expect(Object.keys(P)).toHaveLength(PLACES.length);
    // The check can fail: the seed's own Osaka Castle is adopted when a bundle has it.
    const osaka = place({ name: "Osaka Castle", city_code: "OSA", category: "castle_palace", lat: 34.687, lon: 135.526 });
    const root2 = tempBundleRoot();
    writeBundle(root2, { date: "2026-11-24", places: [osaka] });
    const adopted = planLoad(seededActivities(), await readBundle(localStore(root2), "2026-11-24"), "2026-11-24T00:00:00Z").adopted;
    expect(adopted).toEqual([expect.objectContaining({ activityId: "act-osa-castle", placeId: osaka.id })]);
  });

  it("knows which golden-bundle places the seed adopts, so the end-to-end search can avoid them", async () => {
    const { bundle } = await selectBundle(localStore(GOLDEN_BUNDLE_DIR));
    const plan = planLoad(seededActivities(), bundle!, "2026-11-24T00:00:00Z");
    const adoptedIds = new Set(plan.adopted.map((a) => a.placeId));
    const asakura = bundle!.places.find((p) => (p.name_en ?? p.name) === "Asakura Museum of Sculpture");
    expect(asakura, "the end-to-end search looks for this golden place").toBeDefined();
    expect(adoptedIds.has(asakura!.id)).toBe(false);
  });
});

describe("words", () => {
  it("folds case, accents, plurals and stop words", () => {
    expect(tokens("Temples in Kyoto")).toEqual(["temple", "kyoto"]);
    expect(tokens("Café Zürich")).toEqual(["cafe", "zurich"]);
    expect(tokens("浅草寺")).toEqual(["浅草寺"]);
    expect(tokens("the")).toEqual(["the"]); // only stop words: keep them rather than search for nothing
    expect(dbTokens("Temples in Kyoto")).toEqual(expect.arrayContaining(["temple", "kyoto"]));
  });

  it("scores a name match above a context match above nothing", () => {
    const sensoji = cand({ id: "a", title: "Senso-ji", nameLocal: "浅草寺", category: "temple_shrine", cityName: "Tokyo" });
    expect(lexicalScore("Senso-ji", sensoji)).toBe(1);
    expect(lexicalScore("浅草寺", sensoji)).toBe(1);
    expect(lexicalScore("senso", sensoji)).toBeGreaterThanOrEqual(0.9);
    const context = lexicalScore("temple tokyo", sensoji);
    expect(context).toBeGreaterThan(0);
    expect(context).toBeLessThan(0.6);
    expect(lexicalScore("ramen", sensoji)).toBe(0);
  });

  it("measures distance on the globe", () => {
    expect(haversineKm({ lat: 35.0116, lon: 135.7681 }, { lat: 34.6937, lon: 135.5023 })).toBeCloseTo(42.8, 0); // Kyoto to Osaka
  });
});

describe("combining the signals", () => {
  const exact = cand({ id: "exact", title: "Ramen Alley", rank: 30 });
  const similar = cand({ id: "similar", title: "Noodle House", rank: 1 });

  it("puts an exact name match above a place that is only close in meaning", () => {
    const a = combine(exact, { similarity: null, lexical: 1, distanceKm: null }, true);
    const b = combine(similar, { similarity: 0.5, lexical: 0, distanceKm: null }, true);
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.match).toBe("name");
    expect(b.match).toBe("meaning");
    expect(b.reason).toMatch(/Similar in meaning/);
  });

  it("says both when the name and the meaning agree, and counts only the words without vectors", () => {
    expect(combine(exact, { similarity: 0.8, lexical: 1, distanceKm: null }, true).match).toBe("both");
    const wordsOnly = combine(exact, { similarity: 0.8, lexical: 1, distanceKm: null }, false);
    expect(wordsOnly.match).toBe("name");
    expect(wordsOnly.score).toBeCloseTo(0.95 + 0.05 / (1 + Math.log2(30)), 5);
  });

  it("weights add up to one", () => {
    expect(WEIGHTS.semantic + WEIGHTS.lexical + WEIGHTS.prior).toBeCloseTo(1, 10);
  });
});

describe("relevance metrics (same definitions as the pipeline's eval)", () => {
  it("scores the example the Python test uses and summarises by kind and language", () => {
    const m = scoreQuery(["x", "a", "y", "b", "z"], new Set(["a", "b", "c"]));
    expect(m["recall@1"]).toBe(0);
    expect(m["success@5"]).toBe(1);
    expect(m["recall@5"]).toBeCloseTo(2 / 3, 10);
    expect(m.mrr).toBe(0.5);
    const ideal = 1 + 1 / Math.log2(3) + 1 / Math.log2(4);
    expect(m["ndcg@10"]).toBeCloseTo((1 / Math.log2(3) + 1 / Math.log2(5)) / ideal, 10);
    expect(scoreQuery(["a"], new Set(["a"]))["ndcg@10"]).toBe(1);
    const report = summarise(
      [
        { id: "1", text: "a", lang: "en", kind: "name", relevant: ["a"] },
        { id: "2", text: "b", lang: "ja", kind: "name", relevant: ["zzz"] },
      ],
      [["a"], ["q"]],
    );
    expect(report.overall).toMatchObject({ queries: 2, mrr: 0.5 });
    expect(report.byLang.en!.mrr).toBe(1);
    expect(report.byLang.ja!.mrr).toBe(0);
    expect(renderMarkdown(report, "t")).toContain("| lang: ja | 1 |");
  });
});

describe("the request", () => {
  it("parses filters, clamps nothing silently, and defaults near's radius", () => {
    const ok = searchQuery.parse({ q: "  quiet viewpoint ", city: "kyo", tag: "Nature", near: "34.67, 135.5", limit: "10" });
    expect(ok).toMatchObject({ q: "quiet viewpoint", city: "KYO", tag: "nature", near: { lat: 34.67, lon: 135.5 }, km: 5, limit: 10 });
    expect(searchQuery.parse({ q: "x", km: "3" }).km).toBeUndefined(); // km means nothing without near
    expect(searchQuery.safeParse({ q: "" }).success).toBe(false);
    expect(searchQuery.safeParse({ q: "x".repeat(201) }).success).toBe(false);
    expect(searchQuery.safeParse({ q: "x", limit: 51 }).success).toBe(false);
    expect(searchQuery.safeParse({ q: "x", near: "95,10" }).success).toBe(false);
  });
});

describe("scores from each database", () => {
  it("turns FalkorDB's distance and Neo4j's 0..1 similarity into cosine", () => {
    expect(scoreToSimilarity("falkordb", 0)).toBe(1); // identical: distance 0
    expect(scoreToSimilarity("falkordb", 1)).toBe(0); // orthogonal
    expect(scoreToSimilarity("neo4j", 1)).toBe(1);
    expect(scoreToSimilarity("neo4j", 0.5)).toBe(0);
  });
});

describe("the exact matrix", () => {
  const rows = [
    { id: "a", cityCode: "KYO", category: "temple_shrine", lat: 35.0, lon: 135.7, tags: ["culture"], vector: [1, 0, 0] },
    { id: "b", cityCode: "KYO", category: "cafe", lat: 35.01, lon: 135.76, tags: ["food"], vector: [0.8, 0.6, 0] },
    { id: "c", cityCode: "OSA", category: "cafe", lat: 34.69, lon: 135.5, tags: ["food"], vector: [0, 1, 0] },
    { id: "d", cityCode: "OSA", category: "park", lat: null, lon: null, tags: [], vector: [3, 0, 0] }, // not unit length
  ];
  const m = buildMatrix(3, rows);

  it("returns cosine, best first, with ties broken by id, whatever the vector's length", () => {
    const top = m.nearest(new Float32Array([1, 0, 0]), 4);
    expect(top.map((r) => r.id)).toEqual(["a", "d", "b", "c"]); // a and d tie at 1 (d is three times as long): by id
    expect(top.map((r) => r.similarity)).toEqual([expect.closeTo(1, 5), expect.closeTo(1, 5), expect.closeTo(0.8, 5), expect.closeTo(0, 5)]);
    expect(m.similarity(new Float32Array([2, 0, 0]), "b")).toBeCloseTo(0.8, 5);
    expect(m.similarity(new Float32Array([1, 0, 0]), "zzz")).toBeNull();
  });

  it("filters before ranking, so a filtered answer is never short", () => {
    const q = new Float32Array([1, 0, 0]);
    expect(m.nearest(q, 5, { cityCode: "OSA" }).map((r) => r.id)).toEqual(["d", "c"]);
    expect(m.nearest(q, 5, { category: "cafe" }).map((r) => r.id)).toEqual(["b", "c"]);
    expect(m.nearest(q, 5, { tag: "food", cityCode: "KYO" }).map((r) => r.id)).toEqual(["b"]);
    expect(m.nearest(q, 5, { near: { lat: 35.0, lon: 135.7, km: 10 } }).map((r) => r.id)).toEqual(["a", "b"]);
    expect(() => m.nearest(new Float32Array([1, 0]), 1)).toThrow(/2 values.*3/);
  });

  it("is about 33 MB for the whole catalogue (8,000 x 1,024 float32)", () => {
    expect(8000 * 1024 * 4).toBeLessThan(34_000_000);
    expect(buildMatrix(4, rows.map((r) => ({ ...r, vector: [...r.vector, 0] }))).bytes).toBe(4 * 4 * 4 + 4 * 4);
  });

  it("loads in pages, once per revision", async () => {
    const vectorsPage = vi.fn(async (after: string, limit: number) => rows.filter((r) => r.id > after).slice(0, limit));
    const cache = new MatrixCache({ vectorsPage });
    const state = { revision: "r1", dims: 3, count: 4 };
    const [x, y] = await Promise.all([cache.get(state), cache.get(state)]);
    expect(x).toBe(y);
    expect(x.size).toBe(4);
    const calls = vectorsPage.mock.calls.length;
    await cache.get(state);
    expect(vectorsPage.mock.calls.length).toBe(calls);
    await cache.get({ ...state, revision: "r2" });
    expect(vectorsPage.mock.calls.length).toBeGreaterThan(calls);
  });

  it("refuses a catalogue too large for the instance", async () => {
    await expect(new MatrixCache({ vectorsPage: async () => [] }).get({ revision: "x", dims: 1024, count: 100_000 })).rejects.toThrow(/stops at/);
  });
});

describe("limits", () => {
  it("rate limits a member per minute and frees them when the minute passes", () => {
    let now = 0;
    const g = new SearchGovernor({ perMinute: 3, dailyEmbeds: 2, now: () => now });
    expect([g.hit("u"), g.hit("u"), g.hit("u")]).toEqual([null, null, null]);
    expect(g.hit("u")).toBe(60);
    expect(g.hit("someone-else")).toBeNull();
    now = 61_000;
    expect(g.hit("u")).toBeNull();
  });

  it("caps hosted embeddings per member per UTC day", () => {
    let now = Date.parse("2026-11-24T23:59:00Z");
    const g = new SearchGovernor({ perMinute: 99, dailyEmbeds: 2, now: () => now });
    g.countEmbed("u");
    g.countEmbed("u");
    expect(g.embedsLeft("u")).toBe(0);
    expect(g.embedsLeft("v")).toBe(2);
    now = Date.parse("2026-11-25T00:01:00Z");
    expect(g.embedsLeft("u")).toBe(2);
  });

  it("opens a breaker after three failures and lets a try through after the cool-off", () => {
    let now = 0;
    const b = new Breaker(3, 1000, () => now);
    b.failure();
    b.failure();
    expect(b.open).toBe(false);
    b.failure();
    expect(b.open).toBe(true);
    now = 1001;
    expect(b.open).toBe(false);
    b.success();
    b.failure();
    expect(b.open).toBe(false);
  });

  it("remembers the most recent questions only", () => {
    const c = new QueryCache<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");
    c.set("c", 3);
    expect([c.get("a"), c.get("b"), c.get("c")]).toEqual([1, undefined, 3]);
  });
});

describe("the Cloudflare embedder", () => {
  const TOKEN = "cf-token-that-must-never-appear-in-an-error";
  const reply = (values: number[], init: ResponseInit = {}) =>
    new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { shape: [1, values.length], data: [values] } }), { status: 200, ...init });
  const dims = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? 3 : i === 1 ? 4 : 0));

  it("posts the question as {text: [..]} with a bearer token and returns a unit vector", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => reply(dims(1024)));
    const e = createCloudflareEmbedder({ accountId: "acct1", apiToken: TOKEN, fetch: fetchMock as unknown as typeof fetch });
    const v = await e.embed("quiet viewpoints");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct1/ai/run/@cf/baai/bge-m3");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init?.body))).toEqual({ text: ["quiet viewpoints"] });
    expect(v).toHaveLength(1024);
    expect(v[0]).toBeCloseTo(0.6, 5);
    expect(v[1]).toBeCloseTo(0.8, 5);
  });

  it("fails with messages that never carry the token, the request or the response body", async () => {
    const cases: [() => Promise<Response>, RegExp][] = [
      [async () => new Response("{}", { status: 401 }), /HTTP 401/],
      [async () => new Response("<html>", { status: 200 }), /not JSON/],
      [async () => reply(dims(512)), /512 values, expected 1024/],
      [async () => reply(Array(1024).fill(0)), /zero vector/],
      [
        async () => {
          throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
        },
        /could not be reached/,
      ],
    ];
    for (const [fn, message] of cases) {
      const e = createCloudflareEmbedder({ accountId: "a", apiToken: TOKEN, fetch: fn as unknown as typeof fetch });
      const error = await e.embed("x").catch((err: unknown) => err);
      expect(error).toBeInstanceOf(EmbedError);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });

  it("only accepts vectors from the same model family and size as the loaded ones", () => {
    const e = createCloudflareEmbedder({ accountId: "a", apiToken: "t" });
    expect(e.compatible({ model: "bge-m3-q8", dims: 1024 })).toEqual({ ok: true });
    expect(e.compatible({ model: "bge-m3", dims: 1024 })).toEqual({ ok: true });
    expect(e.compatible({ model: "multilingual-e5-small", dims: 384 })).toMatchObject({ ok: false });
    expect(e.compatible({ model: "bge-m3", dims: 768 })).toMatchObject({ ok: false });
  });

  it("is configured only when both variables are set", () => {
    const base = { SEARCH_FAKE_DIMS: 64, CLOUDFLARE_EMBED_MODEL: "@cf/baai/bge-m3" };
    expect(embedderFromConfig({ ...base })).toBeNull();
    expect(embedderFromConfig({ ...base, CLOUDFLARE_ACCOUNT_ID: "a" })).toBeNull();
    expect(embedderFromConfig({ ...base, CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" })?.name).toBe("cloudflare:@cf/baai/bge-m3");
    expect(embedderFromConfig({ ...base, CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", SEARCH_EMBEDDER: "off" })).toBeNull();
    expect(embedderFromConfig({ ...base, SEARCH_EMBEDDER: "fake" })?.name).toBe("fake-64");
    expect(() => embedderFromConfig({ ...base, SEARCH_EMBEDDER: "cloudflare" })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it("makes the fake's vectors deterministic, unit length, and closer for similar words", () => {
    const a = fakeVector("Fushimi Inari Shrine", 64);
    expect(Array.from(a)).toEqual(Array.from(fakeVector("Fushimi Inari Shrine", 64)));
    expect(a.reduce((s, x) => s + x * x, 0)).toBeCloseTo(1, 5);
    const dot = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(a, fakeVector("Inari shrine in Fushimi", 64))).toBeGreaterThan(dot(a, fakeVector("ramen noodles", 64)));
  });
});

describe("an embeddings run", () => {
  const places = [place({ name: "Alpha Temple" }), place({ name: "Beta Garden" }), place({ name: "Gamma Cafe" })];
  const make = (options = {}) => {
    const root = mkdtempSync(join(tmpdir(), "trippr-emb-"));
    const manifest = writeFakeRun(root, "2026-11-24", places, { dims: 16, ...options });
    return { root, manifest, store: localStore(root) };
  };

  it("reads back what the pipeline wrote, with its checks", async () => {
    const { store } = make();
    const run = await readEmbeddingsRun(store, "2026-11-24");
    expect(run.placeIds).toEqual(places.map((p) => p.id));
    expect(run.matrix).toHaveLength(3 * 16);
    expect(Array.from(run.matrix.subarray(0, 16))).toEqual(Array.from(fakeVector("Alpha Temple · museum", 16)));
    expect(run.manifest).toMatchObject({ model: "fake-16", dims: 16, count: 3 });
  });

  it("reads a run the real pipeline wrote (fixture made by `trippr-data embed --model fake-16 --limit 5`)", async () => {
    const run = await readEmbeddingsRun(localStore(join(import.meta.dirname, "fixtures/embeddings")), "2026-11-18");
    expect(run.manifest).toMatchObject({ stage: "embed", model: "fake-16", dims: 16, count: 5, text_version: "v1" });
    expect(run.placeIds[0]).toBe("foursquare:20fd0a7fb3924e5eb889ffe2");
    // Values numpy printed for row 0, so a byte-order or layout mistake in either language shows here.
    expect(Array.from(run.matrix.subarray(0, 4))).toEqual([0.10949397087097168, -0.15147821605205536, -0.030360594391822815, 0.05595576390624046].map(Math.fround));
    expect(run.contentHashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a run whose files do not match the manifest", async () => {
    await expect(readEmbeddingsRun(make({ corrupt: "matrix" }).store, "2026-11-24")).rejects.toThrow(/embeddings\.f32 does not match its checksum/);
    await expect(readEmbeddingsRun(make({ corrupt: "ids" }).store, "2026-11-24")).rejects.toThrow(/ids\.json does not match its checksum/);
    const { root } = make();
    const file = join(root, "2026-11-24", "manifest.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"count": 3', '"count": 4'));
    await expect(readEmbeddingsRun(localStore(root), "2026-11-24")).rejects.toThrow(/lists 3 places, but the manifest says 4/);
  });

  it("checks the run against the bundle's place ids", async () => {
    const run = await readEmbeddingsRun(make({ skip: (p: { name: string }) => p.name.startsWith("Gamma") }).store, "2026-11-24");
    expect(checkCoverage(run, places)).toEqual({ covered: 2, missing: 1, extra: 0 });
    expect(checkCoverage(run, places.slice(0, 1))).toEqual({ covered: 1, missing: 0, extra: 1 });
    expect(() => checkCoverage(run, [place({ name: "Elsewhere" })])).toThrow(/none of the bundle's 1 places/);
  });

  it("calls a different model or size a conflict, and a quantised build of the same model not", async () => {
    const { manifest } = make();
    const loaded = (over: Partial<IndexState>): IndexState => ({
      model: "fake-16", version: "1", dims: 16, textVersion: "v1", count: 3, bundleDate: "2026-11-24", loadedAt: "x", revision: "r", ...over,
    });
    expect(conflictWith(null, manifest)).toBeNull();
    expect(conflictWith(loaded({}), manifest)).toBeNull();
    expect(conflictWith(loaded({ dims: 32 }), manifest)).toMatch(/32-dimension.*16/);
    expect(conflictWith(loaded({ model: "bge-m3" }), manifest)).toMatch(/from bge-m3.*fake-16/);
    expect(conflictWith(loaded({ model: "bge-m3" }), { ...manifest, model: "bge-m3-q8", dims: 16 })).toBeNull();
  });

  it("looks for embeddings next to the bundles", () => {
    expect(defaultEmbeddingsLocation("gs://bucket/bundles/")).toBe("gs://bucket/embeddings");
    expect(defaultEmbeddingsLocation("pipelines/out/bundles")).toBe("pipelines/out/embeddings");
    expect(defaultEmbeddingsLocation("C:\\data\\bundles")).toBe("C:\\data/embeddings");
    expect(defaultEmbeddingsLocation("bundles")).toBe("embeddings");
    expect(defaultEmbeddingsLocation("/somewhere/else")).toBeNull();
  });
});

describe("the search service, with stand-in repositories", () => {
  const STATE: IndexState = { model: "fake-32", version: "1", dims: 32, textVersion: "v1", count: 3, bundleDate: "d", loadedAt: "t", revision: "r1" };
  const titles: Record<string, string> = { p1: "Quiet Garden", p2: "Loud Arcade", p3: "Garden Cafe" };
  const candidates = Object.entries(titles).map(([id, title], i) => cand({ id, title, rank: i + 1 }));
  const card = (id: string) => ({ id, title: titles[id], cityCode: "KYO", cityName: "Kyoto", tags: [], plannedIn: [], votes: 0 }) as unknown as LibraryActivity;

  function build(options: { state?: IndexState | null; nearest?: () => Promise<{ id: string; similarity: number }[]>; path?: "auto" | "index" | "exact"; embedder?: ReturnType<typeof createFakeEmbedder> | null; daily?: number } = {}) {
    const embedder = options.embedder === undefined ? createFakeEmbedder(32) : options.embedder;
    const nearest = vi.fn(options.nearest ?? (async () => [{ id: "p1", similarity: 0.9 }, { id: "p3", similarity: 0.5 }]));
    const vectorsPage = vi.fn(async (after: string) => (after ? [] : [
      { id: "p1", cityCode: "KYO", category: null, lat: null, lon: null, tags: [], vector: Array.from(fakeVector("Quiet Garden", 32)) },
      { id: "p2", cityCode: "OSA", category: null, lat: null, lon: null, tags: [], vector: Array.from(fakeVector("Loud Arcade", 32)) },
    ]));
    const filterBy = (filters: { cityCode?: string }) => (c: SearchCandidate) => !filters.cityCode || c.cityCode === filters.cityCode;
    const repos = {
      search: {
        indexState: async () => (options.state === undefined ? STATE : options.state),
        nearest,
        vectorsPage,
        candidates: async (_t: string, ids: string[], f: { cityCode?: string }) => candidates.filter((c) => ids.includes(c.id)).filter(filterBy(f)),
        lexical: async (_t: string, tokens: string[]) => candidates.filter((c) => tokens.some((t) => c.title.toLowerCase().includes(t))),
      },
      activities: { list: async (_t: string, _u: string, f: { ids: string[] }) => f.ids.map(card) },
    } as unknown as Repositories;
    const log = { warn: vi.fn(), info: vi.fn() };
    const config = {
      SEARCH_FAKE_DIMS: 32, CLOUDFLARE_EMBED_MODEL: "@cf/baai/bge-m3", SEARCH_EMBED_TIMEOUT_MS: 200,
      SEARCH_VECTOR_PATH: options.path ?? "auto", SEARCH_STATE_TTL_MS: 10_000, SEARCH_RATE_PER_MINUTE: 100, SEARCH_DAILY_LIMIT: options.daily ?? 5,
    } as const;
    const search = createSearch({ repos, config, log, embedder });
    const run = (q: string, extra = {}, caller = { id: "u1", isDemo: false }): Promise<SearchResponse> => search.run(caller, "trip", searchQuery.parse({ q, ...extra }));
    return { search, run, nearest, vectorsPage, log, embedder };
  }

  it("ranks by vectors and words together and says which path answered", async () => {
    const { run, nearest } = build();
    const r = await run("garden");
    expect(r.mode).toBe("hybrid");
    expect(r.engine).toBe("index");
    expect(r.notice).toBeNull();
    expect(r.hits.map((h) => h.activity.id)).toEqual(["p1", "p3"]);
    expect(r.hits[0]).toMatchObject({ match: "both", similarity: 0.9 });
    expect(nearest).toHaveBeenCalledTimes(1);
  });

  it("answers on words alone, with a notice, when there is no embedder, no vectors or the model differs", async () => {
    const none = await build({ embedder: null }).run("garden");
    expect(none).toMatchObject({ mode: "lexical", engine: null, notice: { code: "no_embedder" } });
    expect(none.hits.map((h) => h.activity.id).sort()).toEqual(["p1", "p3"]);
    expect((await build({ state: null }).run("garden")).notice?.code).toBe("no_vectors");
    expect((await build({ state: { ...STATE, model: "bge-m3", dims: 1024 } }).run("garden")).notice?.code).toBe("model_mismatch");
  });

  it("does not call the hosted embedder for the demo account", async () => {
    const { run, embedder } = build();
    expect((await run("garden", {}, { id: "demo", isDemo: true })).notice?.code).toBe("demo");
    expect(embedder!.calls).toEqual([]);
  });

  it("falls back to words when the embedder fails or is too slow, and stops asking after repeated failures", async () => {
    const failing = createFakeEmbedder(32);
    failing.failWith = new EmbedError("The embedder answered HTTP 500", 500);
    const { run } = build({ embedder: failing });
    for (let i = 0; i < 3; i++) expect((await run(`garden ${i}`)).notice?.code).toBe("embedder_unavailable");
    const callsBefore = failing.calls.length;
    expect((await run("garden again")).notice?.code).toBe("embedder_unavailable");
    expect(failing.calls.length).toBe(callsBefore); // the breaker is open: no more waiting

    const slow = createFakeEmbedder(32);
    slow.delayMs = 5000;
    const started = Date.now();
    const r = await build({ embedder: slow }).run("garden");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r).toMatchObject({ mode: "lexical", notice: { code: "embedder_unavailable" } });
    expect(r.hits.length).toBeGreaterThan(0); // the page still has results
  });

  it("caps hosted searches per member per day but not repeated questions, and keeps answering on words", async () => {
    const { run, embedder } = build({ daily: 2 });
    expect((await run("one")).mode).toBe("hybrid");
    expect((await run("one")).mode).toBe("hybrid"); // cached: free
    expect((await run("two")).mode).toBe("hybrid");
    const third = await run("three garden");
    expect(third).toMatchObject({ mode: "lexical", notice: { code: "daily_limit" } });
    expect(embedder!.calls).toEqual(["one", "two"]);
    expect((await run("one", {}, { id: "u2", isDemo: false })).mode).toBe("hybrid"); // another member
  });

  it("uses the exact scan when filtered, and falls back to it when the index fails", async () => {
    const filtered = build();
    const r = await filtered.run("garden", { city: "KYO" });
    expect(r.engine).toBe("exact");
    expect(filtered.nearest).not.toHaveBeenCalled();
    expect(r.hits.map((h) => h.activity.id)).toContain("p1");

    const broken = build({ nearest: async () => Promise.reject(new Error("unknown procedure db.idx.vector.queryNodes")) });
    const a = await broken.run("garden");
    expect(a.engine).toBe("exact");
    expect(a.mode).toBe("hybrid");
    await broken.run("garden two");
    expect(broken.nearest).toHaveBeenCalledTimes(1); // the broken index is skipped for a while
    expect(broken.log.warn).toHaveBeenCalled();
  });

  it("with the index forced and failing, answers on words and says the vectors are unavailable", async () => {
    const { run } = build({ path: "index", nearest: async () => Promise.reject(new Error("no index")) });
    expect(await run("garden")).toMatchObject({ mode: "lexical", notice: { code: "vectors_unavailable" } });
  });

  it("with the exact path forced, never asks the index", async () => {
    const { run, nearest, vectorsPage } = build({ path: "exact" });
    expect((await run("garden")).engine).toBe("exact");
    expect(nearest).not.toHaveBeenCalled();
    expect(vectorsPage).toHaveBeenCalled();
  });
});

describe("the assistant's tool", () => {
  const response = (over: Partial<SearchResponse> = {}): SearchResponse => ({
    query: "q", mode: "hybrid", notice: null, engine: "index", truncated: false,
    hits: [{
      activity: { id: "cat-1", title: "Garden", cityCode: "KYO", cityName: "Kyoto", category: "park", tags: ["nature"], votes: 2, plannedIn: [{ routeId: "route-main", routeName: "Main", stopId: "s" }], address: "1 Path", website: null, lat: 35.123456789, lon: 135.1 } as unknown as LibraryActivity,
      score: 0.7, similarity: 0.8, lexical: 0.5, match: "both", reason: "The name matches and the meaning is close (80% similar)", distanceKm: 1.2,
    }],
    ...over,
  });

  it("calls the search endpoint as the asking member with its filters and tells the model why each place matched", async () => {
    const call = vi.fn(async () => response());
    const ctx = { tripId: "asia-2027", seen: new Seen(), currentRouteId: "route-main", routeIds: ["route-main"], call } as unknown as ToolContext;
    const prepared = prepareTool("semantic_search", { query: "quiet gardens", cityCode: "kyo", near: { lat: 35.01, lon: 135.76 }, km: 3, limit: 5 }, ctx);
    expect(prepared.label).toBe('Searching for "quiet gardens" in KYO…');
    const result = (await prepared.run()) as ReturnType<typeof trimSearch>;
    const url = new URL(`http://x${(call.mock.calls[0] as unknown as [string])[0]}`);
    expect(url.pathname).toBe("/trips/asia-2027/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "quiet gardens", limit: "5", city: "KYO", near: "35.01,135.76", km: "3" });
    expect(result.results[0]).toMatchObject({ id: "cat-1", why: expect.stringContaining("meaning is close"), plannedOnCurrentRoute: true, lat: 35.12346 });
    expect(ctx.seen.activities.get("cat-1")).toBe("Garden"); // citable in the answer
  });

  it("is read-only and bounded, tells the model when it ran on words, and rejects bad input", () => {
    const seen = new Seen();
    const lexical = trimSearch(response({ mode: "lexical", notice: { code: "no_embedder", message: "words only" } }), null, seen);
    expect(lexical).toMatchObject({ mode: "lexical", note: "words only" });
    const many = response({ hits: Array.from({ length: 30 }, (_, i) => ({ ...response().hits[0]!, activity: { ...response().hits[0]!.activity, id: `cat-${i}` } })) });
    expect(trimSearch(many, null, seen).results).toHaveLength(15);
    const ctx = { tripId: "t", seen, currentRouteId: null, routeIds: [], call: async () => ({}) } as unknown as ToolContext;
    expect(() => prepareTool("semantic_search", { query: "" }, ctx)).toThrow(/Invalid input/);
    expect(() => prepareTool("semantic_search", { query: "x", limit: 99 }, ctx)).toThrow(/Invalid input/);
  });
});

describe("the vector never leaves through an ordinary query", () => {
  const dir = join(import.meta.dirname, "../src/repositories/cypher");
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));

  it("returns Activity nodes only as explicit projections, never whole or with .*", () => {
    // A whole node, properties(a), or a {.*} projection of a node that can be an Activity would carry 4 KB of vector.
    const leak = /\bRETURN\b[^\n]*(?<!AS\s)\b(a|act|activity|n|node)\s*(,|$)|properties\(\s*(a|act|activity|n|node)\s*\)|\b(a|act|activity|node)\s*\{\s*\.\*/im;
    const offenders = files(dir)
      .filter((f) => f.endsWith(".cypher"))
      .filter((f) => !f.includes(`${join("search", "vectors-page")}`))
      .filter((f) => leak.test(readFileSync(f, "utf8").replace(/\/\/.*$/gm, "")))
      .map((f) => f.slice(dir.length + 1));
    expect(offenders, `these queries could return an Activity's vector: ${offenders.join(", ")}`).toEqual([]);
  });

  it("names the vector in exactly the queries that read or write it", () => {
    const mentions = files(dir)
      .filter((f) => f.endsWith(".cypher") && /\.embedding\b|embedding'|'embedding/.test(readFileSync(f, "utf8").replace(/\/\/.*$/gm, "")))
      .map((f) => f.slice(dir.length + 1).replace(/\\/g, "/"))
      .sort();
    expect(mentions).toEqual([
      "search/embedding-clear.cypher",
      "search/embedding-write.falkordb.cypher",
      "search/embedding-write.neo4j.cypher",
      "search/index-create.falkordb.cypher",
      "search/index-create.neo4j.cypher",
      "search/index-drop-alt.falkordb.cypher",
      "search/index-drop.falkordb.cypher",
      "search/nearest.falkordb.cypher",
      "search/nearest.neo4j.cypher",
      "search/vectors-page.cypher",
    ]);
  });
});
