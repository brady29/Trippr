import type { ActivityPage, LibraryActivity, SearchResponse } from "@trippr/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepositories } from "../src/repositories";
import { scoreToSimilarity } from "../src/repositories/search";
import { localStore } from "../src/services/catalogue/bundle";
import { runLoadJob, type JobArgs } from "../src/services/catalogue/job";
import { createFakeEmbedder, fakeVector } from "../src/services/search/embedder";
import { fakePlaceText, writeFakeRun } from "../src/services/search/fake-run";
import { createSearch } from "../src/services/search/service";
import { place, tempBundleRoot, writeBundle } from "./bundle-kit";
import { client, signIn, startHarness, type Harness } from "./harness";

/**
 * Semantic search against the real databases (DB_DIALECT=falkordb | neo4j in CI). Vectors come from the fake embedder
 * (32 dimensions), so nothing here says anything about search QUALITY; it checks that the plumbing is right:
 *  - the vector index is created, filled and queried with the statements in repositories/cypher/search/,
 *  - each database's score means what search.ts says it means (FalkorDB: cosine distance, Neo4j: (1 + cos) / 2),
 *  - the index and the exact scan agree,
 *  - the load job refuses a model change, and the endpoint degrades to words instead of failing.
 * If the index tests fail, the message names the database and prints the scores it returned.
 */

const TRIP = "asia-2027";
const DIMS = 32;
const DATE = "2026-11-24";

const P = {
  ramen: place({ name: "Ichiran Ramen", city_code: "TYO", category: "restaurant", tag: "food", rank: 1, lat: 35.659, lon: 139.7 }),
  shrine: place({ name: "Meiji Shrine", city_code: "TYO", category: "temple_shrine", tag: "culture", rank: 2, lat: 35.676, lon: 139.699 }),
  tower: place({ name: "Sky Tower Observation Deck", city_code: "TYO", category: "viewpoint", tag: "nature", rank: 3, lat: 35.71, lon: 139.81 }),
  garden: place({ name: "Quiet Moss Garden", city_code: "OSA", category: "park", tag: "nature", rank: 1, lat: 34.69, lon: 135.52 }),
  castle: place({ name: "Osaka Castle", city_code: "OSA", category: "castle_palace", tag: "culture", rank: 2, lat: 34.687, lon: 135.526 }),
  // Has no vector: found by its words only.
  alley: place({ name: "Hidden Ramen Alley", city_code: "TYO", category: "restaurant", tag: "food", rank: 9, lat: 35.66, lon: 139.71 }),
};
const PLACES = Object.values(P);
const byId = new Map(PLACES.map((p) => [p.id, p]));

let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;
let viewer: Awaited<ReturnType<typeof signIn>>;
let stranger: Awaited<ReturnType<typeof signIn>>;
const embedder = createFakeEmbedder(DIMS);
const bundles = tempBundleRoot();
const embeddings = tempBundleRoot();
const log: string[] = [];

const load = (over: Partial<JobArgs> = {}) =>
  runLoadJob({ dryRun: false, json: false, help: false, ...over }, { db: h.db, store: localStore(bundles), embeddingsStore: localStore(embeddings), log: (l) => log.push(l) });
const search = async (q: string, params: Record<string, string | number> = {}, api = owner.api) => {
  const query = new URLSearchParams({ q, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  return api.get<SearchResponse>(`/trips/${TRIP}/search?${query}`);
};
const ids = (r: SearchResponse) => r.hits.map((x) => x.activity.id);

/** Exact cosine of a question to every vectored place, best first: the answer the databases are checked against. */
function exactRanking(q: string) {
  const query = fakeVector(q, DIMS);
  return PLACES.filter((p) => p !== P.alley)
    .map((p) => {
      const v = fakeVector(fakePlaceText(p), DIMS);
      return { id: p.id, similarity: v.reduce((s, x, i) => s + x * query[i]!, 0) };
    })
    .sort((a, b) => b.similarity - a.similarity);
}

/** The index may need a moment (Neo4j builds in the background); poll so a slow build is not a flaky failure. */
async function nearestWhenReady(repos: ReturnType<typeof createRepositories>, q: string, k: number) {
  let last: Awaited<ReturnType<typeof repos.search.nearest>> = [];
  let error: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      last = await repos.search.nearest(fakeVector(q, DIMS), k);
      error = undefined;
      if (last.length >= Math.min(k, PLACES.length - 1)) return last;
    } catch (e) {
      error = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The ${h.db.dialect} vector index did not answer with ${k} rows within 20 s. Last result: ${JSON.stringify(last)}${error ? `; last error: ${error instanceof Error ? error.message : String(error)}` : ""}`);
}

beforeAll(async () => {
  h = await startHarness({ queryEmbedder: embedder, env: { SEARCH_EMBED_TIMEOUT_MS: "400", SEARCH_RATE_PER_MINUTE: "40", SEARCH_DAILY_LIMIT: "60" } });
  owner = await signIn(h.app, "Search Owner");
  viewer = await signIn(h.app, "Search Viewer");
  stranger = await signIn(h.app, "Search Stranger");
  await owner.api.post(`/invites/${h.ownerInvite}/accept`);
  const invite = await owner.api.post(`/trips/${TRIP}/invites`, { role: "viewer" });
  await viewer.api.post(`/invites/${invite.body.token}/accept`);
  writeBundle(bundles, { date: DATE, places: PLACES });
  writeFakeRun(embeddings, DATE, PLACES, { dims: DIMS, skip: (p) => p === P.alley });
});

afterAll(async () => {
  await h?.close();
});

describe("loading vectors", () => {
  it("a dry run says what it would do and writes nothing", async () => {
    const r = await load({ dryRun: true });
    expect(r.exitCode).toBe(0);
    expect(r.embeddings).toMatchObject({ dryRun: true, covered: 5, missing: 1, dims: DIMS });
    expect(await createRepositories(h.db).search.indexState()).toBeNull();
  });

  it("creates the vector index, writes the vectors and records what they are", async () => {
    const r = await load();
    expect(r.exitCode).toBe(0);
    expect(r.embeddings, log.join("\n")).toMatchObject({ covered: 5, missing: 1, written: 5, unchanged: 0, rebuilt: false, model: `fake-${DIMS}`, dims: DIMS });
    const state = await createRepositories(h.db).search.indexState();
    expect(state).toMatchObject({ model: `fake-${DIMS}`, dims: DIMS, count: 5, bundleDate: DATE, textVersion: "v1" });
  });

  it("is idempotent, and rewrites only the vectors whose content changed", async () => {
    const before = await createRepositories(h.db).search.indexState();
    const again = await load();
    expect(again.embeddings).toMatchObject({ written: 0, unchanged: 5 });
    expect((await createRepositories(h.db).search.indexState())?.revision).toBe(before?.revision); // the API's in-memory copy stays valid

    writeFakeRun(embeddings, DATE, PLACES, { dims: DIMS, skip: (p) => p === P.alley, text: (p) => (p === P.castle ? "Osaka Castle, a fortress with a moat" : fakePlaceText(p)) });
    const changed = await load();
    expect(changed.embeddings).toMatchObject({ written: 1, unchanged: 4 });
    expect((await createRepositories(h.db).search.indexState())?.revision).not.toBe(before?.revision);
    // Put the first run back for the rest of the file.
    writeFakeRun(embeddings, DATE, PLACES, { dims: DIMS, skip: (p) => p === P.alley });
    expect((await load()).embeddings).toMatchObject({ written: 1 });
  });

  it("never returns a vector from the ordinary library queries", async () => {
    const list = await owner.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`);
    const page = await owner.api.get<ActivityPage>(`/trips/${TRIP}/activities/page?scope=catalogue&limit=100`);
    expect(page.body.items.length).toBeGreaterThanOrEqual(6);
    for (const res of [list, page]) {
      expect(res.text).not.toMatch(/embedding/i);
      expect(res.text.length, "a vector is about 4 KB; five of them would show").toBeLessThan(200_000);
    }
  });
});

describe("the vector index", () => {
  const repos = () => createRepositories(h.db);

  it("answers a nearest-neighbour query, and its scores mean what repositories/search.ts says they mean", async () => {
    for (const q of ["Ichiran Ramen", "quiet garden", "castle in Osaka"]) {
      const exact = exactRanking(q);
      const got = await nearestWhenReady(repos(), q, 5);
      const context = `${h.db.dialect} index for "${q}": got ${JSON.stringify(got)}, exact ${JSON.stringify(exact)}. The native score is converted with scoreToSimilarity("${h.db.dialect}", score); if the similarities differ from the exact cosine, that conversion is wrong for this database version.`;
      expect(got.map((r) => r.id), context).toEqual(exact.map((r) => r.id));
      got.forEach((r, i) => expect(r.similarity, context).toBeCloseTo(exact[i]!.similarity, 2));
    }
  });

  it("puts an identical vector at similarity 1 (FalkorDB distance 0, Neo4j score 1) and ranks best first", async () => {
    const q = fakePlaceText(P.shrine);
    const got = await nearestWhenReady(repos(), q, 5);
    expect(got[0]!.id, JSON.stringify(got)).toBe(P.shrine.id);
    expect(got[0]!.similarity, `${h.db.dialect}: ${JSON.stringify(got[0])}`).toBeCloseTo(1, 2);
    expect(got.map((r) => r.similarity)).toEqual([...got.map((r) => r.similarity)].sort((a, b) => b - a));
    expect(scoreToSimilarity(h.db.dialect, h.db.dialect === "falkordb" ? 0 : 1)).toBe(1);
  });

  it("returns at most k rows and only places with a vector", async () => {
    expect(await repos().search.nearest(fakeVector("anything", DIMS), 2)).toHaveLength(2);
    const all = await repos().search.nearest(fakeVector("anything", DIMS), 50);
    expect(all.map((r) => r.id).sort()).toEqual(PLACES.filter((p) => p !== P.alley).map((p) => p.id).sort());
  });

  it("creating the index twice is harmless", async () => {
    await repos().search.ensureVectorIndex(DIMS);
    await repos().search.ensureVectorIndex(DIMS);
  });

  it("pages every vector back for the exact scan, in id order, with the metadata its filters use", async () => {
    const first = await repos().search.vectorsPage("", 3);
    const rest = await repos().search.vectorsPage(first.at(-1)!.id, 10);
    const all = [...first, ...rest];
    expect(all.map((r) => r.id)).toEqual(PLACES.filter((p) => p !== P.alley).map((p) => p.id).sort());
    expect(first).toHaveLength(3);
    const row = all.find((r) => r.id === P.garden.id)!;
    expect(row).toMatchObject({ cityCode: "OSA", category: "park", tags: ["nature"] });
    expect(row.vector).toHaveLength(DIMS);
    expect(row.vector[0]).toBeCloseTo(fakeVector(fakePlaceText(P.garden), DIMS)[0]!, 4); // float32 round trip, not mangled
  });
});

describe("the two vector paths", () => {
  const engineFor = (path: "index" | "exact" | "auto") =>
    createSearch({ repos: createRepositories(h.db), config: { ...h.config, SEARCH_VECTOR_PATH: path }, log: { warn: () => {}, info: () => {} }, embedder, stateTtlMs: 0 });
  const caller = () => ({ id: "path-tester", isDemo: false });
  const params = (q: string, extra: object = {}) => ({ q, limit: 20, ...extra }) as Parameters<ReturnType<typeof createSearch>["run"]>[2];

  it("give the same places in the same order, and say which one answered", async () => {
    await nearestWhenReady(createRepositories(h.db), "garden", 5);
    for (const q of ["ramen", "quiet moss garden", "osaka castle"]) {
      const viaIndex = await engineFor("index").run(caller(), TRIP, params(q));
      const viaExact = await engineFor("exact").run(caller(), TRIP, params(q));
      expect(viaIndex.engine).toBe("index");
      expect(viaExact.engine).toBe("exact");
      expect(viaIndex.mode).toBe("hybrid");
      // The exact scan can also score the place that has no vector by meaning; the index cannot, so compare the rest.
      const vectored = (r: SearchResponse) => ids(r).filter((id) => id !== P.alley.id);
      expect(vectored(viaIndex), `${h.db.dialect}, "${q}": index and exact scan disagree`).toEqual(vectored(viaExact));
    }
  });

  it("prefers the exact scan when filtered (the index cannot filter), and answers filtered queries completely", async () => {
    const r = await engineFor("auto").run(caller(), TRIP, params("quiet garden", { city: "OSA" }));
    expect(r.engine).toBe("exact");
    expect(r.hits.map((x) => x.activity.cityCode)).toEqual(Array(r.hits.length).fill("OSA"));
    expect(r.hits[0]!.activity.id).toBe(P.garden.id);
    expect(r.truncated).toBe(false);
  });

  it("falls back to the exact scan when the index is gone", async () => {
    const repos = createRepositories(h.db);
    await repos.search.dropVectorIndex();
    try {
      // A dropped index either errors or answers nothing, depending on the database; both must end in the exact scan.
      const dropped = await repos.search.nearest(fakeVector("garden", DIMS), 3).catch(() => []);
      expect(dropped, `${h.db.dialect} still answered from a dropped index`).toEqual([]);
      const r = await engineFor("auto").run(caller(), TRIP, params("quiet moss garden"));
      expect(r.engine, `${h.db.dialect}: with no index, auto should serve from the exact scan`).toBe("exact");
      expect(r.hits[0]!.activity.id).toBe(P.garden.id);
    } finally {
      await repos.search.ensureVectorIndex(DIMS);
      await repos.search.awaitVectorIndex();
      await nearestWhenReady(repos, "garden", 3);
    }
  });
});

describe("GET /trips/:id/search", () => {
  it("ranks by meaning and name, with the reason and the card the Activities page shows", async () => {
    const r = await search("Ichiran Ramen");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: "hybrid", notice: null, query: "Ichiran Ramen" });
    expect(["index", "exact"]).toContain(r.body.engine);
    const top = r.body.hits[0]!;
    expect(top.activity).toMatchObject({ id: P.ramen.id, title: "Ichiran Ramen", cityCode: "TYO", catalogue: true });
    expect(top.activity.sources?.[0]).toMatchObject({ source: "overture" });
    expect(top).toMatchObject({ match: "both", lexical: 1 });
    expect(top.similarity).toBeGreaterThan(0.6);
    expect(top.reason).toMatch(/name matches/i);
    expect(JSON.stringify(r.body)).not.toMatch(/embedding/i);
  });

  it("finds a place that has no vector by its words, and still ranks it", async () => {
    const r = await search("hidden ramen alley");
    expect(r.body.mode).toBe("hybrid");
    expect(r.body.hits[0]!.activity.id).toBe(P.alley.id);
    expect(r.body.hits[0]!.similarity).toBeNull();
  });

  it("filters by city, tag, category and distance, and keeps the filters' places complete", async () => {
    const city = await search("garden castle", { city: "OSA" });
    expect(new Set(city.body.hits.map((x) => x.activity.cityCode))).toEqual(new Set(["OSA"]));
    expect(ids(city.body)).toEqual(expect.arrayContaining([P.garden.id, P.castle.id]));
    const tag = await search("tower garden", { tag: "nature" });
    expect(ids(tag.body).sort()).toEqual([P.garden.id, P.tower.id].sort());
    const category = await search("ramen", { category: "restaurant" });
    expect(ids(category.body)).toEqual(expect.arrayContaining([P.ramen.id, P.alley.id]));
    expect(category.body.hits.every((x) => x.activity.category === "restaurant")).toBe(true);
    const near = await search("shrine ramen tower", { near: "35.66,139.70", km: 3 });
    expect(ids(near.body)).toEqual(expect.arrayContaining([P.ramen.id, P.shrine.id]));
    expect(ids(near.body)).not.toContain(P.tower.id); // about 11 km away
    expect(ids(near.body)).not.toContain(P.garden.id); // another city
    expect(near.body.hits.every((x) => x.distanceKm !== null && x.distanceKm <= 3)).toBe(true);
  });

  it("does not return what is not worth showing", async () => {
    const r = await search("zzzzqqqq");
    expect(r.status).toBe(200);
    expect(r.body.hits.length).toBeLessThanOrEqual(PLACES.length);
    expect(r.body.hits.every((x) => x.score > 0)).toBe(true);
  });

  it("follows the trip's access rules: viewers may search, strangers and signed-out callers may not", async () => {
    expect((await search("ramen", {}, viewer.api)).status).toBe(200);
    expect((await search("ramen", {}, stranger.api)).status).toBe(404);
    expect((await search("ramen", {}, client(h.app))).status).toBe(401);
    expect((await owner.api.get(`/trips/${TRIP}/search`)).status).toBe(400);
    expect((await search("ramen", { limit: 500 })).status).toBe(400);
  });

  it("answers on words, with a notice, when the embedder fails or is too slow, and the page does not break", async () => {
    embedder.failWith = new Error("boom");
    try {
      const r = await search("quiet moss garden failing");
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ mode: "lexical", engine: null, notice: { code: "embedder_unavailable" } });
      expect(ids(r.body)).toContain(P.garden.id);
    } finally {
      embedder.failWith = undefined;
    }
    embedder.delayMs = 3000;
    try {
      const started = Date.now();
      const r = await search("quiet moss garden slow", {}, viewer.api);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(r.body).toMatchObject({ mode: "lexical", notice: { code: "embedder_unavailable" } });
    } finally {
      embedder.delayMs = undefined;
    }
  });
});

describe("limits", () => {
  it("answers 429 with Retry-After when a member searches too fast", async () => {
    const fast = await signIn(h.app, "Search Fast");
    await owner.api.post(`/trips/${TRIP}/invites`, { role: "viewer" }).then((i) => fast.api.post(`/invites/${i.body.token}/accept`));
    const statuses: number[] = [];
    let last: Awaited<ReturnType<typeof search>> | undefined;
    for (let i = 0; i < 45; i++) {
      last = await search("ramen", {}, fast.api);
      statuses.push(last.status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(40);
    expect(statuses.at(-1)).toBe(429);
    expect(last!.body).toMatchObject({ error: { code: "rate_limited" } });
    expect(Number(last!.headers["retry-after"])).toBeGreaterThan(0);
    expect((await search("ramen", {}, viewer.api)).status).toBe(200); // someone else is unaffected
  });
});

describe("a model or size change", () => {
  it("is refused before anything is written, and loads once the index is rebuilt", async () => {
    const newcomer = place({ name: "Newcomer Noodles", city_code: "TYO", category: "restaurant", tag: "food", rank: 20 });
    const second = [...PLACES, newcomer];
    writeBundle(bundles, { date: "2026-11-25", places: second });
    writeFakeRun(embeddings, "2026-11-25", second, { dims: 16, model: "fake-16", skip: (p) => p === P.alley });

    const refused = await load().catch((e: unknown) => e as Error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/Refusing to load the embeddings of 2026-11-25.*32-dimension.*16.*--rebuild-index/);
    const repos = createRepositories(h.db);
    expect(await repos.search.indexState()).toMatchObject({ dims: DIMS, bundleDate: DATE }); // untouched
    const page = await owner.api.get<ActivityPage>(`/trips/${TRIP}/activities/page?scope=catalogue&q=newcomer`);
    expect(page.body.total, "the places of the refused load must not have been written either").toBe(0);

    const rebuilt = await load({ rebuildIndex: true });
    expect(rebuilt.embeddings).toMatchObject({ rebuilt: true, dims: 16, written: 6, model: "fake-16" });
    expect(await repos.search.indexState()).toMatchObject({ model: "fake-16", dims: 16, count: 6, bundleDate: "2026-11-25" });
    expect((await owner.api.get<ActivityPage>(`/trips/${TRIP}/activities/page?scope=catalogue&q=newcomer`)).body.total).toBe(1);
  });

  it("then answers on words alone for the embedder whose size no longer matches, and says so", async () => {
    const r = await search("quiet moss garden mismatch");
    expect(r.body).toMatchObject({ mode: "lexical", notice: { code: "model_mismatch" } });
    expect(ids(r.body)).toContain(P.garden.id);
    expect(byId.size).toBe(PLACES.length);
  });

  it("refuses a run for another bundle, and a corrupt one when it was named", async () => {
    const unrelated = place({ name: "Unrelated Place" });
    writeBundle(bundles, { date: "2026-11-26", places: [unrelated] });
    writeFakeRun(embeddings, "2026-11-26", PLACES, { dims: 16, model: "fake-16" });
    await expect(load({ date: "2026-11-26" })).rejects.toThrow(/none of the bundle's 1 places/);
    writeFakeRun(embeddings, "2026-11-26", [unrelated], { dims: 16, model: "fake-16", corrupt: "matrix" });
    await expect(load({ date: "2026-11-26", embeddingsDate: "2026-11-26" })).rejects.toThrow(/does not match its checksum/);
    // Unnamed, a corrupt run only skips the vectors: the places still load.
    const skipped = await load({ date: "2026-11-26" });
    expect(skipped.exitCode).toBe(0);
    expect(skipped.embeddings).toBeUndefined();
    expect(log.join("\n")).toMatch(/skipped embeddings 2026-11-26/);
  });
});
