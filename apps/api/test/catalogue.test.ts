import type { ActivityFacets, ActivityPage, DataSourcesResponse, LibraryActivity, RouteView, StopLibrary } from "@trippr/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localStore } from "../src/services/catalogue/bundle";
import { runLoadJob } from "../src/services/catalogue/job";
import { client, signIn, startHarness, type Harness } from "./harness";
import { GOLDEN_BUNDLE_DIR, enrichment, place, tempBundleRoot, writeBundle } from "./bundle-kit";

// Run on both databases in CI (DB_DIALECT=falkordb | neo4j).

const TRIP = "asia-2027";
const MAIN = "route-main";

let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;
let viewer: Awaited<ReturnType<typeof signIn>>;
let tokyoStop: string;

const log: string[] = [];
const load = async (root: string, options: { date?: string; dryRun?: boolean } = {}) => {
  const result = await runLoadJob({ dryRun: options.dryRun ?? false, json: false, help: false, ...(options.date ? { date: options.date } : {}) }, { db: h.db, store: localStore(root), log: (l) => log.push(l) });
  return result;
};
const page = async (query = "") => (await owner.api.get<ActivityPage>(`/trips/${TRIP}/activities/page${query}`)).body;
const titles = (p: ActivityPage) => p.items.map((i) => i.title);

// Places for the tests. Names are unique so they are easy to find.
const sky = place({ name: "Catalogue Sky", category: "viewpoint", tag: "nature", score: 5, rank: 1, city_code: "TYO", website: "https://sky.example.com" });
const tower = place({ name: "Catalogue Tower", category: "landmark", tag: "culture", score: 4, rank: 2, city_code: "TYO", name_local: "カタログタワー" });
const ramen = place({ name: "Catalogue Ramen", category: "restaurant", tag: "food", score: 1, rank: 9, city_code: "TYO" });
const castle = place({
  name: "Catalogue Castle",
  category: "castle_palace",
  tag: "culture",
  score: 4.5,
  rank: 1,
  city_code: "OSA",
  sources: [{ source: "foursquare", source_id: "fsq-castle", licence: "Apache-2.0", fetched_at: "2026-11-18T00:00:00Z", raw_ref: "raw/foursquare/OSA.parquet" }],
});
// The same place as the seeded, hand-written "teamLab Planets" in Tokyo.
const teamlab = place({ name: "teamLab Planets TOKYO", name_en: "teamLab Planets TOKYO", category: "science_tech", tag: "tech", score: 4.8, rank: 3, city_code: "TYO", lat: 35.6491, lon: 139.7898, address: "6 Chome-1-16 Toyosu" });

const FIRST = [sky, tower, ramen, castle, teamlab];

beforeAll(async () => {
  h = await startHarness();
  owner = await signIn(h.app, "Catalogue Owner");
  viewer = await signIn(h.app, "Catalogue Viewer");
  await owner.api.post(`/invites/${h.ownerInvite}/accept`);
  const invite = await owner.api.post(`/trips/${TRIP}/invites`, { role: "viewer" });
  await viewer.api.post(`/invites/${invite.body.token}/accept`);
  tokyoStop = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body.stops.find((s) => s.city.code === "TYO")!.id;
});

afterAll(async () => {
  await h?.close();
});

describe("the load job", () => {
  const root = tempBundleRoot();

  it("a dry run says what would change and writes nothing", async () => {
    writeBundle(root, { date: "2026-11-20", places: FIRST });
    const before = (await owner.api.get<ActivityFacets>(`/trips/${TRIP}/activities/facets`)).body.totals;
    const result = await load(root, { dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.summary).toMatchObject({ dryRun: true, created: 4, adopted: [{ activityId: "act-teamlab" }] });
    expect((await owner.api.get<ActivityFacets>(`/trips/${TRIP}/activities/facets`)).body.totals).toEqual(before);
    expect((await client(h.app).get<DataSourcesResponse>("/data/sources")).body.latestLoad).toBeNull();
  });

  it("loads the places as ideas, matches the hand-written activity, and keeps provenance", async () => {
    await owner.api.put(`/activities/act-teamlab/vote`, { value: 1 });
    const result = await load(root);
    expect(result.summary).toMatchObject({ created: 4, refreshed: 0, unchanged: 0, unlisted: 0, removed: 0 });

    const all = await page("?scope=catalogue&limit=100");
    expect(titles(all)).toEqual(expect.arrayContaining(["Catalogue Sky", "Catalogue Tower", "Catalogue Ramen", "Catalogue Castle"]));
    const loaded = all.items.find((i) => i.title === "Catalogue Sky")!;
    expect(loaded).toMatchObject({ catalogue: true, listed: true, category: "viewpoint", score: 5, rank: 1, placeStatus: "placed", cityCode: "TYO", website: "https://sky.example.com" });
    expect(loaded.sources).toEqual([{ source: "overture", sourceId: `ov-${sky.id}`, licence: "CDLA-Permissive-2.0" }]);
    expect(loaded.tags).toEqual(["nature"]);
    expect(loaded.plannedIn).toEqual([]);

    // The hand-written teamLab: same id, same vote, now with a pin and sources; no second teamLab.
    const mine = (await owner.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`)).body.find((a) => a.id === "act-teamlab")!;
    expect(mine).toMatchObject({ votes: 1, myVote: 1, lat: 35.6491, lon: 139.7898, placeStatus: "placed", category: "science_tech", title: "teamLab Planets" });
    expect(mine.catalogue).toBeUndefined();
    expect(mine.sources?.[0]).toMatchObject({ source: "overture" });
    expect(all.items.some((i) => i.title.startsWith("teamLab"))).toBe(false);
  });

  it("is idempotent", async () => {
    const result = await load(root);
    expect(result.summary).toMatchObject({ created: 0, refreshed: 0, unchanged: 5, unlisted: 0, removed: 0, adopted: [] });
    const facets = (await owner.api.get<ActivityFacets>(`/trips/${TRIP}/activities/facets`)).body;
    expect(facets.totals.catalogue).toBe(4);
  });

  it("keeps the whole library out of the list the rest of the app reads", async () => {
    const mineOnly = (await owner.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`)).body;
    expect(mineOnly.some((a) => a.catalogue)).toBe(false);
    expect(mineOnly.length).toBeLessThan(400);
    const forCity = (await owner.api.get<LibraryActivity[]>(`/cities/TYO/activities?tripId=${TRIP}`)).body;
    expect(forCity.some((a) => a.catalogue)).toBe(false);
  });

  it("keeps votes, plans, edits and hand-placed pins through a newer bundle", async () => {
    const skyId = sky.id;
    await owner.api.put(`/activities/${skyId}/vote`, { value: 1 });
    await viewer.api.put(`/activities/${skyId}/vote`, { value: 1 });
    const planned = await owner.api.put<RouteView>(`/stops/${tokyoStop}/plans/${skyId}`, { day: 2 });
    expect(planned.status).toBe(200);
    await owner.api.patch(`/activities/${skyId}`, { title: "Our Sky" });
    await owner.api.patch(`/activities/${tower.id}/place`, { lat: 35.7, lon: 139.8 });

    // Newer bundle: Sky's score and website change, the tower moves, ramen and the castle are dropped.
    const newer = { ...sky, score: 6, rank: 1, website: "https://new.example.com", lat: 35.6001 };
    const movedTower = { ...tower, lat: 35.61, lon: 139.71 };
    writeBundle(root, { date: "2026-11-27", places: [newer, movedTower, teamlab] });
    const result = await load(root);
    expect(result.summary).toMatchObject({ refreshed: 2, created: 0, removed: 2 });

    const sk = (await page(`?scope=catalogue&q=sky`)).items[0]!;
    // An edited place keeps its text: the new website from the bundle is not applied.
    expect(sk).toMatchObject({ title: "Our Sky", score: 6, votes: 2, website: "https://sky.example.com" });
    expect(sk.plannedIn).toHaveLength(1);
    const tw = (await page(`?q=tower`)).items.find((i) => i.title === "Catalogue Tower")!;
    expect(tw).toMatchObject({ lat: 35.7, lon: 139.8, placeStatus: "manual" }); // a pin set by hand never moves
  });

  it("removes dropped places nobody used and marks the used ones no longer listed", async () => {
    const titlesNow = titles(await page("?scope=catalogue&limit=100&includeUnlisted=true"));
    expect(titlesNow).not.toContain("Catalogue Ramen");
    expect(titlesNow).not.toContain("Catalogue Castle");
    await owner.api.put(`/activities/${tower.id}/vote`, { value: -1 });

    writeBundle(root, { date: "2026-11-28", places: [teamlab] });
    const result = await load(root);
    expect(result.summary).toMatchObject({ unlisted: 2 }); // Sky is planned, voted and edited; the tower is voted
    const unlisted = await page("?scope=mine&q=sky");
    const sk = unlisted.items.find((i) => i.title === "Our Sky")!;
    expect(sk).toMatchObject({ listed: false, votes: 2 });
    expect(sk.plannedIn).toHaveLength(1);
    // The headline count is of listed places only.
    expect((await owner.api.get<ActivityFacets>(`/trips/${TRIP}/activities/facets`)).body.totals.catalogue).toBe(0);
  });

  it("brings a place back when a bundle lists it again, and leaves a deleted one deleted", async () => {
    const del = await owner.api.del(`/activities/${tower.id}`);
    expect(del.status).toBe(204);
    writeBundle(root, { date: "2026-11-29", places: [sky, tower, teamlab] });
    const result = await load(root);
    expect(result.summary?.skippedHidden).toBe(1);
    expect(titles(await page("?q=catalogue&scope=all&includeUnlisted=true&limit=100"))).not.toContain("Catalogue Tower");
    const back = (await page("?scope=mine&q=sky")).items.find((i) => i.title === "Our Sky")!;
    expect(back.listed).toBe(true);
    expect(back.votes).toBe(2);
  });

  it("skips a newest bundle that failed its checks and loads the one before", async () => {
    writeBundle(root, { date: "2026-12-30", places: [sky], passed: false });
    const result = await load(root);
    expect(result.summary?.bundleDate).toBe("2026-11-29");
    expect(log.some((l) => l.includes("skipped bundle 2026-12-30"))).toBe(true);
  });
});

describe("filters and paging", () => {
  const root = tempBundleRoot();
  const many = Array.from({ length: 7 }, (_, i) =>
    place({ name: `Paged Place ${String(i + 1).padStart(2, "0")}`, city_code: "UKY", category: i < 4 ? "temple_shrine" : "park_garden", tag: i < 4 ? "culture" : "nature", score: 10 - i, rank: i + 1 }),
  );

  // The seed has Kyoto ideas of its own; they show up beside the catalogue places in every unscoped count.
  const own = { all: 0, culture: 0 };

  beforeAll(async () => {
    own.all = (await page("?scope=mine&city=UKY")).total;
    own.culture = (await page("?scope=mine&city=UKY&tag=culture")).total;
    writeBundle(root, { date: "2026-11-30", places: many });
    const res = await runLoadJob({ dryRun: false, json: false, help: false }, { db: h.db, store: localStore(root), log: () => {} });
    expect(res.exitCode).toBe(0);
  });

  it("pages in the order asked for, and says where the next page starts", async () => {
    const first = await page("?scope=catalogue&city=UKY&limit=3&sort=score");
    expect(titles(first)).toEqual(["Paged Place 01", "Paged Place 02", "Paged Place 03"]);
    expect(first).toMatchObject({ total: 7, offset: 0, limit: 3, nextOffset: 3 });
    const last = await page("?scope=catalogue&city=UKY&limit=3&offset=6&sort=score");
    expect(titles(last)).toEqual(["Paged Place 07"]);
    expect(last.nextOffset).toBeNull();
    expect(titles(await page("?scope=catalogue&city=UKY&sort=title&limit=2"))).toEqual(["Paged Place 01", "Paged Place 02"]);
  });

  it("filters by category, tag, text, source, score and rank", async () => {
    expect((await page("?city=UKY&category=park_garden")).total).toBe(3);
    expect((await page("?city=UKY&tag=culture")).total).toBe(4 + own.culture);
    expect(titles(await page("?city=UKY&q=PLACE%2005"))).toEqual(["Paged Place 05"]);
    expect((await page("?city=UKY&source=overture")).total).toBe(7);
    expect((await page("?city=UKY&source=foursquare")).total).toBe(0);
    expect((await page("?city=UKY&minScore=8")).total).toBe(3);
    expect((await page("?city=UKY&maxRank=2")).total).toBe(2);
    expect((await page("?scope=mine&city=UKY")).total).toBe(own.all);
  });

  it("offers the filter menus and the headline numbers", async () => {
    const f = (await owner.api.get<ActivityFacets>(`/trips/${TRIP}/activities/facets`)).body;
    expect(f.cities.find((c) => c.code === "UKY")).toMatchObject({ count: 7 + own.all });
    expect(f.categories.map((c) => c.name)).toEqual(expect.arrayContaining(["temple_shrine", "park_garden"]));
    expect(f.sources.find((s) => s.id === "overture")?.count).toBeGreaterThanOrEqual(7);
    expect(f.totals.catalogue).toBeGreaterThanOrEqual(7);
    expect(f.totals.onMap).toBeGreaterThanOrEqual(7);
  });

  it("rejects a bad query, and is for members only", async () => {
    expect((await owner.api.get(`/trips/${TRIP}/activities/page?limit=500`)).status).toBe(400);
    expect((await client(h.app).get(`/trips/${TRIP}/activities/page`)).status).toBe(401);
    expect((await viewer.api.get(`/trips/${TRIP}/activities/page?city=UKY`)).status).toBe(200);
    const stranger = await signIn(h.app, "Stranger");
    expect((await stranger.api.get(`/trips/${TRIP}/activities/page`)).status).toBe(404);
  });

  it("lets a viewer vote on a catalogue place, which then shows in the group's own list", async () => {
    const target = (await page("?city=UKY&q=place%2002")).items[0]!;
    const voted = await viewer.api.put<LibraryActivity>(`/activities/${target.id}/vote`, { value: 1 });
    expect(voted.status).toBe(200);
    expect(voted.body).toMatchObject({ votes: 1, myVote: 1, catalogue: true });
    expect((await owner.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`)).body.map((a) => a.id)).toContain(target.id);
    expect((await page("?scope=mine&city=UKY")).total).toBe(own.all + 1);
  });
});

describe("the Data page's endpoint", () => {
  it("is public and lists sources with licences, counts and the latest load's checks", async () => {
    const res = await client(h.app).get<DataSourcesResponse>("/data/sources");
    expect(res.status).toBe(200);
    const overture = res.body.sources.find((s) => s.id === "overture")!;
    expect(overture).toMatchObject({ name: "Overture Maps Places", enabled: true, version: "2026-11-18.0" });
    expect(overture.licence).toContain("CDLA-Permissive-2.0");
    expect(overture.attribution).toContain("Overture Maps Foundation");
    expect(overture.activities).toBeGreaterThan(0);
    expect(res.body.latestLoad).toMatchObject({ input: "golden", checks: { passed: true } });
    expect(res.body.latestLoad!.checks.results.length).toBeGreaterThan(0);
    expect(res.body.totals.catalogue).toBeGreaterThan(0);
    expect(res.body.notes.length).toBeGreaterThan(0);
  });

  it("is readable by the demo visitor too", async () => {
    const demo = await client(h.app).post<{ token: string }>("/auth/demo");
    expect(demo.status).toBe(200);
    expect((await client(h.app, demo.body.token).get("/data/sources")).status).toBe(200);
  });
});

describe("LLM enrichment", () => {
  const root = tempBundleRoot();
  const mk = (name: string, rank: number, over: Partial<ReturnType<typeof place>> = {}) =>
    place({ name, city_code: "UKY", category: "temple_shrine", tag: "culture", score: 7, rank, ...over });
  const shrine = mk("Enriched Shrine", 21); // indoor, evening, 45 min, $$
  const garden = mk("Enriched Garden", 22, { category: "park_garden", tag: "nature" }); // outdoor, morning, 120 min, free
  const hall = mk("Enriched Hall", 23); // good at any time, 30 min, indoor
  const plain = mk("Plain Place", 24); // never enriched
  const silent = mk("Silent Place", 25); // enriched, but the model had nothing it could support to say

  const enrichmentV1 = [
    enrichment(shrine, { summary: "A quiet hillside shrine.", duration_min: 45, best_time: "evening", indoor: true, price_level: "$$", good_for: ["rain"], tags: ["temple_shrine"], display_name: "Shrine of Quiet", is_generic_name: true }),
    enrichment(garden, { summary: "A large garden with ponds.", duration_min: 120, best_time: "morning", indoor: false, price_level: "free", good_for: ["views", "families"] }),
    enrichment(hall, { summary: "A hall for exhibitions.", duration_min: 30, best_time: "any", indoor: true, price_level: "$" }),
    enrichment(silent, { summary: "", duration_min: null, best_time: null, indoor: null, price_level: null, good_for: [], tags: [] }),
    enrichment(teamlab, { summary: "An art museum with water.", duration_min: 150, best_time: "afternoon", indoor: true, price_level: "$$$", ai_label: "Summary written by AI from Overture Maps" }),
  ];
  const places = [shrine, garden, hall, plain, silent, teamlab];
  const run = (date: string) => runLoadJob({ dryRun: false, json: false, help: false, date }, { db: h.db, store: localStore(root), log: () => {} });
  const ours = (items: LibraryActivity[]) => items.map((i) => i.title).sort();
  const find = async (title: string) => (await page(`?q=${encodeURIComponent(title.toLowerCase())}&includeUnlisted=true`)).items.find((i) => i.title === title)!;

  it("writes the enrichment onto catalogue places, and never over a hand-written activity's own text", async () => {
    // The group's own note on the hand-written activity (not AI-written, so it must survive).
    await h.db.query("MATCH (a:Activity {id: $id}) SET a.summary = $summary", { id: "act-teamlab", summary: "Booked for the first week, bring a towel." });
    writeBundle(root, { date: "2026-12-01", places, enrichment: enrichmentV1, evals: { enrich: { model: "claude-haiku-5-5", judge_model: null, metrics: { n: 174, tag_f1: 0.8 }, targets: { tag_f1: true } } } });
    const result = await run("2026-12-01");
    expect(result.exitCode).toBe(0);
    expect(result.summary).toMatchObject({ created: 5 });

    const s = await find("Enriched Shrine");
    expect(s.enrichment).toEqual({
      tags: ["temple_shrine"],
      summary: "A quiet hillside shrine.",
      summaryAi: true,
      aiLabel: "Summary written by AI from Overture Maps and Wikidata",
      durationMin: 45,
      bestTime: "evening",
      indoor: true,
      priceLevel: "$$",
      goodFor: ["rain"],
      displayName: "Shrine of Quiet",
      isGenericName: true,
      model: "claude-haiku-5-5",
      enrichedAt: "2026-11-18T09:30:00Z",
    });
    expect(s.title).toBe("Enriched Shrine"); // the display name is a suggestion, never the title
    expect((await find("Enriched Garden")).enrichment).toMatchObject({ indoor: false, priceLevel: "free", goodFor: ["views", "families"], isGenericName: false });
    expect((await find("Plain Place")).enrichment).toBeUndefined();
    // Nothing to say: the place is marked enriched, with no summary and no AI label.
    expect((await find("Silent Place")).enrichment).toMatchObject({ summary: null, summaryAi: false, aiLabel: null, durationMin: null, bestTime: null, indoor: null, goodFor: [], tags: [] });

    // The adopted hand-written activity: its own text stays; the empty fields are filled; the title is its own.
    const mine = (await owner.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`)).body.find((a) => a.id === "act-teamlab")!;
    expect(mine.title).toBe("teamLab Planets");
    expect(mine.enrichment).toMatchObject({ summary: "Booked for the first week, bring a towel.", summaryAi: false, aiLabel: null, durationMin: 150, bestTime: "afternoon", indoor: true, priceLevel: "$$$" });
  });

  it("shows the enrichment wherever an activity is read: the page, the detail after a vote, and a stop's library", async () => {
    const id = shrine.id;
    const voted = await owner.api.put<LibraryActivity>(`/activities/${id}/vote`, { value: 1 });
    expect(voted.body.enrichment).toMatchObject({ summary: "A quiet hillside shrine.", summaryAi: true, bestTime: "evening" });
    const list = (await owner.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`)).body.find((a) => a.id === id);
    expect(list?.enrichment?.summaryAi).toBe(true); // voted places join the group's own list
    // The Tokyo stop's library carries the adopted hand-written activity with its enrichment.
    const library = (await owner.api.get<StopLibrary[]>(`/routes/${MAIN}/library`)).body;
    const fromLibrary = library.flatMap((s) => s.activities).find((a) => a.id === "act-teamlab");
    expect(fromLibrary?.enrichment).toMatchObject({ durationMin: 150, bestTime: "afternoon" });
  });

  it("filters on best time, indoor, duration and price level, and combines them", async () => {
    const q = (extra: string) => page(`?scope=catalogue&city=UKY&limit=100${extra}`).then((p) => ours(p.items));
    // Evening: the evening place and the one that is good any time.
    expect(await q("&bestTime=evening")).toEqual(["Enriched Hall", "Enriched Shrine"]);
    expect(await q("&bestTime=morning")).toEqual(["Enriched Garden", "Enriched Hall"]);
    expect(await q("&bestTime=night")).toEqual(["Enriched Hall"]);
    expect(await q("&indoor=true")).toEqual(["Enriched Hall", "Enriched Shrine"]);
    expect(await q("&indoor=false")).toEqual(["Enriched Garden"]); // places the model could not tell are left out
    expect(await q("&durationMax=45")).toEqual(["Enriched Hall", "Enriched Shrine"]);
    expect(await q("&durationMax=30")).toEqual(["Enriched Hall"]);
    expect(await q("&priceLevel=free")).toEqual(["Enriched Garden"]);
    expect(await q(`&priceLevel=${encodeURIComponent("$$")}`)).toEqual(["Enriched Shrine"]);
    expect(await q("&bestTime=evening&indoor=true&durationMax=45")).toEqual(["Enriched Hall", "Enriched Shrine"]);
    expect(await q("&bestTime=evening&indoor=false")).toEqual([]);
    // The group's own list and unfiltered pages are unchanged by the filters being absent.
    expect(await q("&q=enriched")).toHaveLength(3); // text search still works beside them
    expect((await owner.api.get(`/trips/${TRIP}/activities/page?bestTime=dusk`)).status).toBe(400);
    expect((await owner.api.get(`/trips/${TRIP}/activities/page?priceLevel=%24%24%24%24`)).status).toBe(400);
  });

  it("offers counts for the enrichment filters", async () => {
    const f = (await owner.api.get<ActivityFacets>(`/trips/${TRIP}/activities/facets`)).body.enrichment;
    // shrine, garden, hall, silent and the adopted teamLab are enriched; the plain place is not.
    expect(f.enriched).toBe(5);
    expect(f.indoor).toBe(3);
    expect(f.outdoor).toBe(1);
    expect(Object.fromEntries(f.bestTimes.map((b) => [b.name, b.count]))).toEqual({ morning: 1, afternoon: 1, evening: 1, night: 0, any: 1 });
    expect(Object.fromEntries(f.priceLevels.map((b) => [b.name, b.count]))).toEqual({ free: 1, $: 1, $$: 1, $$$: 1 });
    expect(Object.fromEntries(f.durations.map((d) => [d.max, d.count]))).toEqual({ 30: 1, 60: 2, 120: 3, 240: 4 });
  });

  it("is idempotent, and refreshes only the places whose enrichment changed", async () => {
    const same = await run("2026-12-01");
    expect(same.summary).toMatchObject({ created: 0, refreshed: 0, unchanged: 6, removed: 0 });

    // A newer bundle: a new summary for the shrine and a new duration for teamLab's (adopted) activity.
    const next = [{ ...enrichmentV1[0]!, summary: "A hillside shrine with a view." }, ...enrichmentV1.slice(1, 4), { ...enrichmentV1[4]!, duration_min: 90 }];
    writeBundle(root, { date: "2026-12-02", places, enrichment: next });
    const result = await run("2026-12-02");
    expect(result.summary).toMatchObject({ created: 0, refreshed: 1 });
    expect(result.summary!.adopted).toEqual([]); // teamLab was already matched; it is refreshed in place
    expect((await find("Enriched Shrine")).enrichment?.summary).toBe("A hillside shrine with a view.");
    const mine = (await owner.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`)).body.find((a) => a.id === "act-teamlab")!;
    expect(mine.enrichment).toMatchObject({ durationMin: 90, summary: "Booked for the first week, bring a towel.", summaryAi: false });
  });

  it("keeps what the graph already holds when a bundle comes without enrichment", async () => {
    writeBundle(root, { date: "2026-12-03", places });
    const result = await run("2026-12-03");
    expect(result.exitCode).toBe(0);
    expect((await find("Enriched Shrine")).enrichment).toMatchObject({ summary: "A hillside shrine with a view.", summaryAi: true, bestTime: "evening" });
    expect((await page("?scope=catalogue&city=UKY&bestTime=evening")).items.map((i) => i.title)).toContain("Enriched Shrine");
  });

  it("tells the Data page what was enriched, by which model, and how it scored", async () => {
    writeBundle(root, { date: "2026-12-04", places, enrichment: enrichmentV1, evals: { enrich: { model: "claude-haiku-5-5", judge_model: null, metrics: { n: 174, tag_f1: 0.8 }, targets: { tag_f1: true } } } });
    await run("2026-12-04");
    const data = (await client(h.app).get<DataSourcesResponse>("/data/sources")).body;
    expect(data.latestLoad?.enrichment).toEqual({
      places: 5,
      withSummary: 4,
      models: ["claude-haiku-5-5"],
      promptVersions: ["enrich-v1"],
      enrichedAt: "2026-11-18T09:30:00Z",
      sourceDate: "2026-12-04",
    });
    expect(data.latestLoad?.evals).toMatchObject({ enrich: { model: "claude-haiku-5-5", metrics: { tag_f1: 0.8 } } });
    expect(data.totals.enriched).toBe(5);
    expect(data.latestLoad?.counts).not.toHaveProperty("enrichment");
  });
});

describe("the bundle the pipeline's golden test writes", () => {
  it("loads, and loading it twice changes nothing", async () => {
    const first = await runLoadJob({ dryRun: false, json: false, help: false }, { db: h.db, store: localStore(GOLDEN_BUNDLE_DIR), log: () => {} });
    expect(first.exitCode).toBe(0);
    expect(first.summary!.created).toBeGreaterThan(20);
    const again = await runLoadJob({ dryRun: false, json: false, help: false }, { db: h.db, store: localStore(GOLDEN_BUNDLE_DIR), log: () => {} });
    expect(again.summary).toMatchObject({ created: 0, refreshed: 0, unlisted: 0, removed: 0 });
    const data = (await client(h.app).get<DataSourcesResponse>("/data/sources")).body;
    expect(data.latestLoad).toMatchObject({ bundleDate: "2026-11-18", input: "golden" });
  });
});
