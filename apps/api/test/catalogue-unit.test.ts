import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExistingActivity } from "../src/repositories/catalogue";
import { localStore, readBundle, selectBundle } from "../src/services/catalogue/bundle";
import { parseArgs } from "../src/services/catalogue/job";
import { planLoad } from "../src/services/catalogue/loader";
import { GOLDEN_BUNDLE_DIR, place, tempBundleRoot, writeBundle } from "./bundle-kit";

// No database: the bundle reader and the load plan. Runs without Docker
// (pnpm --filter @trippr/api exec vitest run test/catalogue-unit.test.ts).

const existing = (over: Partial<ExistingActivity> & { id: string }): ExistingActivity => ({
  title: over.id,
  mapsQuery: null,
  lat: null,
  lon: null,
  placeStatus: "unplaced",
  geoSource: null,
  catalogue: false,
  adopted: false,
  catalogueId: null,
  sourceKeys: [],
  listed: true,
  hidden: false,
  edited: false,
  contentHash: null,
  cityCode: "TYO",
  cityName: "Tokyo",
  votes: 0,
  plans: 0,
  comments: 0,
  ...over,
});

const bundleOf = (date: string, places: ReturnType<typeof place>[]) => {
  const root = tempBundleRoot();
  writeBundle(root, { date, places });
  return { root, store: localStore(root) };
};

describe("reading bundles", () => {
  it("reads and verifies the bundle the pipeline's golden test commits", async () => {
    const bundle = await readBundle(localStore(GOLDEN_BUNDLE_DIR), "2026-11-18");
    expect(bundle.places.length).toBe(bundle.manifest.counts.places);
    expect(bundle.places.length).toBeGreaterThan(20);
    expect(bundle.sources.map((s) => s.id)).toEqual(expect.arrayContaining(["foursquare", "overture"]));
  });

  it("takes the newest bundle whose checks passed and says why it skipped the others", async () => {
    const root = tempBundleRoot();
    writeBundle(root, { date: "2026-10-26", places: [place({ name: "Old" })] });
    writeBundle(root, { date: "2026-11-26", places: [place({ name: "Failed" })], passed: false });
    writeBundle(root, { date: "2026-11-27", places: [place({ name: "Corrupt" })], corrupt: "places" });
    const choice = await selectBundle(localStore(root));
    expect(choice.bundle?.date).toBe("2026-10-26");
    expect(choice.skipped.map((s) => s.date)).toEqual(["2026-11-27", "2026-11-26"]);
    expect(choice.skipped[0]!.reason).toMatch(/checksum/);
    expect(choice.skipped[1]!.reason).toMatch(/duplicates\.name_50m/);
  });

  it("finds nothing when no bundle is usable, or when a requested date is bad", async () => {
    const root = tempBundleRoot();
    writeBundle(root, { date: "2026-11-26", places: [place({ name: "Failed" })], passed: false });
    expect((await selectBundle(localStore(root))).bundle).toBeNull();
    expect((await selectBundle(localStore(root), "2026-01-01")).bundle).toBeNull();
  });

  it("refuses places that cite a source the bundle does not describe", async () => {
    const root = tempBundleRoot();
    const stray = place({ name: "Stray" });
    stray.sources[0]!.source = "mystery";
    writeBundle(root, { date: "2026-11-26", places: [stray] });
    await expect(readBundle(localStore(root), "2026-11-26")).rejects.toThrow(/mystery/);
  });
});

describe("planning a load", () => {
  const now = "2026-11-26T00:00:00Z";

  it("creates new places as ideas and records nothing else on a first load", async () => {
    const { store } = bundleOf("2026-11-26", [place({ name: "Sky" }), place({ name: "Tower", city_code: "OSA" })]);
    const plan = planLoad([], await readBundle(store, "2026-11-26"), now);
    expect(plan.create).toHaveLength(2);
    expect([plan.refresh, plan.adopt, plan.unlist, plan.remove].map((l) => l.length)).toEqual([0, 0, 0, 0]);
  });

  it("is idempotent: the same bundle over its own result changes nothing", async () => {
    const { store } = bundleOf("2026-11-26", [place({ name: "Sky" }), place({ name: "Tower" })]);
    const bundle = await readBundle(store, "2026-11-26");
    const first = planLoad([], bundle, now);
    const loaded = first.create.map((r) =>
      existing({ id: r.id, catalogue: true, catalogueId: r.id, sourceKeys: r.sourceKeys, contentHash: r.contentHash, title: r.title }),
    );
    const second = planLoad(loaded, bundle, now);
    expect(second.unchanged).toBe(2);
    expect([second.create, second.refresh, second.adopt, second.unlist, second.remove].map((l) => l.length)).toEqual([0, 0, 0, 0, 0]);
  });

  it("refreshes a place whose data changed, and keeps its id when its id changed but a source record is shared", async () => {
    const original = place({ name: "Sky", id: "cat-aaaaaaaaaaaaaaaa" });
    const moved = { ...original, id: "cat-bbbbbbbbbbbbbbbb", score: 4.2 };
    const bundle = await readBundle(bundleOf("2026-11-26", [moved]).store, "2026-11-26");
    const loaded = [existing({ id: original.id, catalogue: true, catalogueId: original.id, sourceKeys: original.sources.map((s) => `${s.source}:${s.source_id}`), contentHash: "old" })];
    const plan = planLoad(loaded, bundle, now);
    expect(plan.create).toHaveLength(0);
    expect(plan.refresh).toHaveLength(1);
    expect(plan.refresh[0]).toMatchObject({ activityId: original.id, catalogueId: moved.id, score: 4.2 });
  });

  it("matches a hand-written activity to the same place and never creates a second one", async () => {
    const teamlab = place({ name: "teamLab Planets TOKYO", rank: 1 });
    const bundle = await readBundle(bundleOf("2026-11-26", [teamlab, place({ name: "Tokyo Tower" })]).store, "2026-11-26");
    const mine = existing({ id: "act-teamlab", title: "teamLab Planets", mapsQuery: "teamLab Planets TOKYO", votes: 2 });
    const plan = planLoad([mine, existing({ id: "act-other", title: "Sumo" })], bundle, now);
    expect(plan.adopted).toEqual([{ activityId: "act-teamlab", placeId: teamlab.id, title: "teamLab Planets" }]);
    expect(plan.adopt[0]).toMatchObject({ activityId: "act-teamlab", catalogueId: teamlab.id });
    expect(plan.create.map((r) => r.title)).toEqual(["Tokyo Tower"]);
  });

  it("removes dropped places nobody used, and keeps the ones the group used, marked no longer listed", async () => {
    const bundle = await readBundle(bundleOf("2026-11-26", [place({ name: "Still here" })]).store, "2026-11-26");
    const gone = (id: string, over: Partial<ExistingActivity> = {}) => existing({ id, catalogue: true, catalogueId: id, ...over });
    const plan = planLoad(
      [
        gone("cat-unused"),
        gone("cat-voted", { votes: 1 }),
        gone("cat-planned", { plans: 1 }),
        gone("cat-commented", { comments: 1 }),
        gone("cat-edited", { edited: true }),
        gone("cat-pinned", { placeStatus: "manual" }),
        gone("cat-already", { votes: 1, listed: false }),
        gone("cat-deleted", { hidden: true }),
      ],
      bundle,
      now,
    );
    expect(plan.remove).toEqual(["cat-unused"]);
    expect(plan.unlist.sort()).toEqual(["cat-commented", "cat-edited", "cat-pinned", "cat-planned", "cat-voted"]);
  });

  it("leaves a place the group deleted deleted", async () => {
    const sky = place({ name: "Sky" });
    const bundle = await readBundle(bundleOf("2026-11-26", [sky]).store, "2026-11-26");
    const hidden = existing({ id: sky.id, catalogue: true, catalogueId: sky.id, hidden: true, listed: false });
    const plan = planLoad([hidden], bundle, now);
    expect(plan.skippedHidden).toBe(1);
    expect([plan.create, plan.refresh, plan.adopt].map((l) => l.length)).toEqual([0, 0, 0]);
  });

  it("brings a no-longer-listed place back when a bundle lists it again", async () => {
    const sky = place({ name: "Sky" });
    const bundle = await readBundle(bundleOf("2026-11-26", [sky]).store, "2026-11-26");
    const first = planLoad([], bundle, now).create[0]!;
    const unlisted = existing({ id: sky.id, catalogue: true, catalogueId: sky.id, contentHash: first.contentHash, listed: false, votes: 1 });
    expect(planLoad([unlisted], bundle, now).refresh).toHaveLength(1);
  });
});

describe("the real seed", () => {
  const seedDir = resolve(import.meta.dirname, "../../../seed");
  const acts = JSON.parse(readFileSync(resolve(seedDir, "activities.json"), "utf8")) as { id: string; city: string; title: string; mapsQuery?: string }[];
  const cities = new Map((JSON.parse(readFileSync(resolve(seedDir, "cities.json"), "utf8")) as { code: string; name: string }[]).map((c) => [c.code, c.name]));
  const seeded = acts.map((a) => existing({ id: a.id, title: a.title, mapsQuery: a.mapsQuery ?? null, cityCode: a.city, cityName: cities.get(a.city)! }));

  it("adopts the seeded teamLab Planets into the catalogue place of that name and nothing else", async () => {
    const teamlab = place({ name: "teamLab Planets TOKYO", name_en: "teamLab Planets TOKYO", category: "science_tech", tag: "tech", rank: 3 });
    const others = [place({ name: "Catalogue Sky" }), place({ name: "Chongqing Hotpot Street", city_code: "CKG" }), place({ name: "Fushimi Inari Taisha", city_code: "OSA" })];
    const bundle = await readBundle(bundleOf("2026-11-26", [teamlab, ...others]).store, "2026-11-26");
    const plan = planLoad(seeded, bundle, "2026-11-26T00:00:00Z");
    expect(plan.adopted).toEqual([{ activityId: "act-teamlab", placeId: teamlab.id, title: "teamLab Planets" }]);
    expect(plan.create).toHaveLength(3);
    expect(plan.adopt[0]).toMatchObject({ activityId: "act-teamlab", title: "teamLab Planets TOKYO" });
  });

  it("matches a Kyoto idea by name in its own city only", async () => {
    const inari = place({ name: "Fushimi Inari Taisha torii trail", city_code: "UKY" });
    const elsewhere = place({ name: "Fushimi Inari Taisha torii trail", city_code: "OSA" });
    const bundle = await readBundle(bundleOf("2026-11-26", [inari, elsewhere]).store, "2026-11-26");
    const plan = planLoad(seeded, bundle, "2026-11-26T00:00:00Z");
    expect(plan.adopted.map((a) => [a.activityId, a.placeId])).toEqual([["act-uky-fushimi-inari", inari.id]]);
  });
});

describe("the job's arguments", () => {
  it("reads flags and falls back to the environment", () => {
    expect(parseArgs(["--bundle", "out/bundles", "--date", "2026-11-22", "--trip", "asia-2027", "--dry-run", "--json"], {})).toMatchObject({
      bundle: "out/bundles",
      date: "2026-11-22",
      trip: "asia-2027",
      dryRun: true,
      json: true,
    });
    expect(parseArgs([], { DATA_BUCKET: "gs://trippr-data", CATALOGUE_TRIP_ID: "t1" })).toMatchObject({ bundle: "gs://trippr-data/bundles", trip: "t1" });
    expect(parseArgs([], { BUNDLE_LOCATION: "/data/bundles", DATA_BUCKET: "x" }).bundle).toBe("/data/bundles");
  });

  it("rejects what it does not understand", () => {
    expect(() => parseArgs(["--nope"], {})).toThrow(/Unknown option/);
    expect(() => parseArgs(["--bundle"], {})).toThrow(/needs a value/);
    expect(() => parseArgs(["--date", "yesterday"], {})).toThrow(/--date/);
  });
});
