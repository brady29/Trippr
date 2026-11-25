import type { RouteView, SuggestionsResponse } from "@trippr/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localStore } from "../src/services/catalogue/bundle";
import { runLoadJob, type JobArgs } from "../src/services/catalogue/job";
import { createFakeEmbedder } from "../src/services/search/embedder";
import { fakePlaceText, writeFakeRun } from "../src/services/search/fake-run";
import { enrichment, place, tempBundleRoot, writeBundle } from "./bundle-kit";
import { client, signIn, startHarness, type Harness } from "./harness";

/**
 * "Suggested for this stop" against the real databases (DB_DIALECT=falkordb | neo4j in CI). The vectors are the fake
 * hashing embedder's (32 dimensions): two places given the same text look alike, everything else is noise, so these tests
 * check the plumbing and the rules (who is excluded, whose votes count, what the reason says, who may read), not
 * recommendation QUALITY (pnpm eval:recommend measures that on a bundle). Nothing here calls an embedder: the fake one is
 * handed to the search service only to prove the suggestions never use it.
 */

const TRIP = "asia-2027";
const MAIN = "route-main";
const DIMS = 32;
const DATE = "2026-11-24";

const T = { lat: 35.68, lon: 139.76 };
const S = { lat: 10.77, lon: 106.7 };
const P = {
  shrine: place({ name: "Hanazono Shrine", city_code: "TYO", category: "temple_shrine", tag: "culture", rank: 1, ...T }),
  shrineTwin: place({ name: "Zenkoku Shrine", city_code: "TYO", category: "temple_shrine", tag: "culture", rank: 2, ...T }),
  ramen: place({ name: "Harbour Ramen", city_code: "TYO", category: "restaurant", tag: "food", rank: 3, ...T }),
  ramenTwin: place({ name: "Lantern Ramen", city_code: "TYO", category: "restaurant", tag: "food", rank: 4, ...T }),
  tower: place({ name: "Skyline Tower Deck", city_code: "TYO", category: "viewpoint", tag: "nature", rank: 5, ...T }),
  museum: place({ name: "Edo Craft Museum", city_code: "TYO", category: "museum", tag: "culture", rank: 6, ...T }),
  market: place({ name: "Ben Thanh Market", city_code: "SGN", category: "market", tag: "food", rank: 1, ...S }),
  post: place({ name: "Saigon Central Post Office", city_code: "SGN", category: "landmark", tag: "culture", rank: 2, ...S }),
  skydeck: place({ name: "Bitexco Skydeck", city_code: "SGN", category: "viewpoint", tag: "nature", rank: 3, ...S }),
  palace: place({ name: "Reunification Palace", city_code: "SGN", category: "castle_palace", tag: "culture", rank: 4, ...S }),
};
const PLACES = Object.values(P);

/** The twins get the text of the place they copy, so their vectors are (nearly) the same. */
const textOf = (p: (typeof PLACES)[number]) =>
  p === P.shrineTwin ? `${fakePlaceText(P.shrine)} annex` : p === P.ramenTwin ? `${fakePlaceText(P.ramen)} annex` : fakePlaceText(p);

let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;
let viewer: Awaited<ReturnType<typeof signIn>>;
let stranger: Awaited<ReturnType<typeof signIn>>;
let tokyoStop = "";
let saigonStop = "";
const embedder = createFakeEmbedder(DIMS);
const bundles = tempBundleRoot();
const embeddings = tempBundleRoot();
const log: string[] = [];

const load = (over: Partial<JobArgs> = {}) =>
  runLoadJob({ dryRun: false, json: false, help: false, ...over }, { db: h.db, store: localStore(bundles), embeddingsStore: localStore(embeddings), log: (l) => log.push(l) });
const suggest = (stop: string, query = "", api = owner.api) => api.get<SuggestionsResponse>(`/stops/${stop}/suggestions${query}`);
const ids = (r: { body: SuggestionsResponse }) => r.body.suggestions.map((s) => s.activity.id);

beforeAll(async () => {
  h = await startHarness({ queryEmbedder: embedder, env: { SEARCH_STATE_TTL_MS: "0" } });
  owner = await signIn(h.app, "Suggest Owner");
  viewer = await signIn(h.app, "Suggest Viewer");
  stranger = await signIn(h.app, "Suggest Stranger");
  await owner.api.post(`/invites/${h.ownerInvite}/accept`);
  const invite = await owner.api.post(`/trips/${TRIP}/invites`, { role: "viewer" });
  await viewer.api.post(`/invites/${invite.body.token}/accept`);
  const route = await owner.api.get<RouteView>(`/routes/${MAIN}`);
  tokyoStop = route.body.stops.find((s) => s.city.code === "TYO")!.id;
  saigonStop = route.body.stops.find((s) => s.city.code === "SGN")!.id;
  writeBundle(bundles, {
    date: DATE,
    places: PLACES,
    enrichment: [
      enrichment(P.tower, { best_time: "evening", indoor: false }),
      enrichment(P.museum, { best_time: "morning", indoor: true }),
      enrichment(P.ramen, { best_time: "any", indoor: true }),
    ],
  });
  writeFakeRun(embeddings, DATE, PLACES, { dims: DIMS, text: textOf });
});

afterAll(async () => {
  await h?.close();
});

describe("before any vectors are loaded", () => {
  it("still suggests the city's top places with a plain reason, and says similarity was not used", async () => {
    const loaded = await load({ noEmbeddings: true });
    expect(loaded.exitCode, log.join("\n")).toBe(0);
    const r = await suggest(tokyoStop);
    expect(r.status).toBe(200);
    expect(r.body.notice, JSON.stringify(r.body.notice)).toMatchObject({ code: "no_vectors" });
    expect(r.body.basis).not.toBe("group_taste");
    expect(r.body.suggestions.length).toBeGreaterThan(0);
    for (const s of r.body.suggestions) {
      expect(s.reason.length).toBeGreaterThan(5);
      expect(s.because).not.toBe("similar");
      expect(s.anchor).toBeNull();
      expect(s.closeness).toBeNull();
    }
  });
});

describe("GET /stops/:id/suggestions", () => {
  it("loads the vectors", async () => {
    const r = await load();
    expect(r.exitCode, log.join("\n")).toBe(0);
    expect(r.embeddings).toMatchObject({ covered: PLACES.length, written: PLACES.length });
  });

  it("cold start: the city's catalogue ranking, leaning toward the tags liked in other cities, with a notice that says so", async () => {
    // Saigon has no votes and nothing planned; the seeded plans in other cities carry the group's tags.
    const r = await suggest(saigonStop);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stopId: saigonStop, cityCode: "SGN", basis: "tag_preferences", signals: { liked: 0, disliked: 0, members: 0 } });
    expect(r.body.likedTags.length).toBeGreaterThan(0);
    expect(r.body.notice).toMatchObject({ code: "cold_start" });
    expect(r.body.notice!.message).toContain("Ho Chi Minh City");
    // Only Saigon's catalogue places, none the group has touched, each with a reason built from rank and tags.
    const got = ids(r);
    expect(got.length).toBeGreaterThan(0);
    for (const id of got) expect(PLACES.filter((p) => p.city_code === "SGN").map((p) => p.id)).toContain(id);
    for (const s of r.body.suggestions) {
      expect(s.activity).toMatchObject({ catalogue: true, plannedIn: [] });
      expect(s.reason, JSON.stringify(s.reason)).toMatch(/Top-ranked|#\d|Ranked #/);
      expect(s.because).not.toBe("similar");
    }
    expect(JSON.stringify(r.body)).not.toMatch(/embedding/i);
  });

  it("follows the group's votes: names the liked place and who voted for it, from the caller's point of view", async () => {
    expect((await owner.api.put(`/activities/${P.shrine.id}/vote`, { value: 1 })).status).toBe(200);
    const asOwner = await suggest(tokyoStop);
    expect(asOwner.body.basis, JSON.stringify(asOwner.body.notice)).toBe("group_taste");
    expect(asOwner.body.notice).toBeNull();
    expect(asOwner.body.signals.liked).toBeGreaterThanOrEqual(1);
    const top = asOwner.body.suggestions[0]!;
    expect(top.activity.id).toBe(P.shrineTwin.id);
    expect(top).toMatchObject({ because: "similar", reason: "Similar to Hanazono Shrine, which you voted for", closeness: "very close" });
    expect(top.anchor).toMatchObject({ activityId: P.shrine.id, title: "Hanazono Shrine", voters: 1, votedByYou: true, planned: false });
    expect(ids(asOwner)).not.toContain(P.shrine.id); // already voted

    const asViewer = await suggest(tokyoStop, "", viewer.api);
    expect(asViewer.body.suggestions[0]!.reason).toBe("Similar to Hanazono Shrine, which one of you voted for");
    expect(asViewer.body.suggestions[0]!.anchor!.votedByYou).toBe(false);

    expect((await viewer.api.put(`/activities/${P.shrine.id}/vote`, { value: 1 })).status).toBe(200);
    const both = await suggest(tokyoStop);
    expect(both.body.suggestions[0]!.reason).toBe("Similar to Hanazono Shrine, which 2 of you voted for");
    expect(both.body.signals.members).toBeGreaterThanOrEqual(2);
  });

  it("respects the limit and the enrichment filters, and leaves out places the enrichment could not tell", async () => {
    expect((await suggest(tokyoStop, "?limit=1")).body.suggestions).toHaveLength(1);
    const sorted = (r: { body: SuggestionsResponse }) => ids(r).sort();
    // The tower is enriched "evening, outdoor", the museum "morning, indoor", the first ramen place "any time, indoor"; nothing else is enriched.
    expect(sorted(await suggest(tokyoStop, "?limit=20&bestTime=evening"))).toEqual([P.tower.id, P.ramen.id].sort());
    expect(sorted(await suggest(tokyoStop, "?limit=20&indoor=false"))).toEqual([P.tower.id]);
    expect(sorted(await suggest(tokyoStop, "?limit=20&indoor=true"))).toEqual([P.museum.id, P.ramen.id].sort());
    const nothing = await suggest(saigonStop, "?limit=20&bestTime=evening"); // nothing in Saigon was enriched
    expect(nothing.body.suggestions).toEqual([]);
    expect(nothing.body.notice).toMatchObject({ code: "none_left" });
    expect((await suggest(tokyoStop, "?limit=0")).status).toBe(400);
    expect((await suggest(tokyoStop, "?limit=99")).status).toBe(400);
    expect((await suggest(tokyoStop, "?bestTime=dawn")).status).toBe(400);
  });

  it("never suggests a place that is planned in any route, voted on, commented on or not in the city", async () => {
    // Plan a ramen place at the Tokyo stop and vote the other down; comment on the tower.
    expect((await owner.api.put(`/stops/${tokyoStop}/plans/${P.ramen.id}`, {})).status).toBe(200);
    expect((await owner.api.put(`/activities/${P.ramenTwin.id}/vote`, { value: -1 })).status).toBe(200);
    expect((await owner.api.post(`/activities/${P.tower.id}/comments`, { text: "Too crowded?" })).status).toBe(201);
    const r = await suggest(tokyoStop, "?limit=20");
    const got = ids(r);
    for (const gone of [P.shrine, P.ramen, P.ramenTwin, P.tower]) expect(got, `${gone.name} should not be suggested`).not.toContain(gone.id);
    expect(got).toEqual(expect.arrayContaining([P.shrineTwin.id, P.museum.id]));
    for (const id of got) expect(PLACES.find((p) => p.id === id)?.city_code, id).toBe("TYO");
    // Also not when the same place is planned by another route of the trip.
    const other = await owner.api.get<RouteView>("/routes/route-japan-rail");
    const otherTokyo = other.body.stops.find((s) => s.city.code === "TYO")!.id;
    expect((await owner.api.put(`/stops/${otherTokyo}/plans/${P.museum.id}`, {})).status).toBe(200);
    expect(ids(await suggest(tokyoStop, "?limit=20"))).not.toContain(P.museum.id);
    expect(ids(await suggest(otherTokyo, "?limit=20"))).not.toContain(P.museum.id);
  });

  it("every suggestion is a card the Activities page shows, with a reason, no number and no vector", async () => {
    const r = await suggest(tokyoStop, "?limit=20");
    expect(r.body.suggestions.length).toBeGreaterThan(0);
    for (const s of r.body.suggestions) {
      expect(s.activity).toMatchObject({ catalogue: true, cityCode: "TYO", votes: 0, myVote: 0 });
      expect(s.activity.sources?.length).toBeGreaterThan(0); // source and licence badges
      expect(s.reason).not.toMatch(/%|\d\.\d|score|similarity|\bAI\b|language model|LLM/i);
    }
    expect(r.text).not.toMatch(/embedding/i);
    expect(r.text.length, "a vector is about 4 KB").toBeLessThan(60_000);
  });

  it("a vote down pushes the taste away from that kind of place", async () => {
    // The group liked shrines; the Tokyo ramen twin was voted down, so its look-alikes are not offered even though the
    // ramen place is far from the shrines: a near-copy of a voted-down place is left out.
    const r = await suggest(tokyoStop, "?limit=20");
    expect(r.body.signals.disliked).toBeGreaterThanOrEqual(1);
    expect(ids(r)).not.toContain(P.ramenTwin.id);
  });

  it("follows the trip's access rules, works for the demo account and calls no embedder", async () => {
    const before = embedder.calls.length;
    expect((await suggest(tokyoStop, "", viewer.api)).status).toBe(200);
    expect((await suggest(tokyoStop, "", stranger.api)).status).toBe(404);
    expect((await suggest(tokyoStop, "", client(h.app))).status).toBe(401);
    expect((await suggest("no-such-stop")).status).toBe(404);
    const demo = await client(h.app).post("/auth/demo");
    const asDemo = await suggest(tokyoStop, "", client(h.app, demo.body.token));
    expect(asDemo.status).toBe(200);
    expect(asDemo.body.suggestions.length).toBeGreaterThan(0);
    expect(embedder.calls.length, "suggestions must never embed anything").toBe(before);
  });

  it("a second route's stop in the same city sees the same suggestions", async () => {
    const other = await owner.api.get<RouteView>("/routes/route-japan-rail");
    const otherTokyo = other.body.stops.find((s) => s.city.code === "TYO")!.id;
    const a = await suggest(tokyoStop, "?limit=20");
    const b = await suggest(otherTokyo, "?limit=20");
    expect(new Set(ids(b))).toEqual(new Set(ids(a)));
  });
});
