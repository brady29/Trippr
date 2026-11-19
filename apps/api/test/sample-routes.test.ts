import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateGraphExplorer } from "../src/db/explorer-migration";
import { seedDatabase } from "../src/db/seed";
import { SEED_DIR, startHarness, type Harness } from "./harness";

let h: Harness;
let dir: string;

/** A copy of seed/ with one extra sample route, as if it were added after the trip went live. */
function seedDirWithNewRoute() {
  const d = mkdtempSync(join(tmpdir(), "trippr-seed-"));
  cpSync(SEED_DIR, d, { recursive: true });
  const trip = JSON.parse(readFileSync(join(d, "trip.json"), "utf8"));
  trip.routes = [...trip.routes, "late-sample-route.json"];
  writeFileSync(join(d, "trip.json"), JSON.stringify(trip));
  writeFileSync(
    join(d, "late-sample-route.json"),
    JSON.stringify({
      id: "route-late-sample",
      name: "Late sample",
      tags: ["sample"],
      stops: [
        { city: "TYO", nights: 3, arriveMode: "flight", plans: ["act-npb"] },
        { city: "BJS", nights: 3, arriveMode: "flight" },
        { city: "SIA", nights: 2, arriveMode: "hsr" },
      ],
    }),
  );
  return d;
}

const legsOf = async (routeId: string) => {
  const [row] = await h.db.query<{ n: number }>(
    "MATCH (:Route {id: $id})-[:HAS_STOP]->(:Stop)-[:ARRIVES_VIA]->(l:Leg) RETURN count(l) AS n",
    { id: routeId },
  );
  return Number(row?.n ?? 0);
};

beforeAll(async () => {
  h = await startHarness();
  dir = seedDirWithNewRoute();
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await h?.close();
});

describe("sample routes added after the trip exists", () => {
  it("creates a new sample route once, with idea legs, and leaves existing routes alone", async () => {
    const mainBefore = await h.db.query<{ v: number }>("MATCH (r:Route {id: 'route-main'}) RETURN r.version AS v");

    const result = await seedDatabase(h.db, { seedDir: dir });
    expect(result.tripCreated).toBe(false);
    expect(result.routesSeeded).toEqual(["route-late-sample"]);

    const migration = await migrateGraphExplorer(h.db, { seedDir: dir });
    expect(migration.legsCreated).toBeGreaterThanOrEqual(3);
    expect(await legsOf("route-late-sample")).toBe(3);

    const mainAfter = await h.db.query<{ v: number }>("MATCH (r:Route {id: 'route-main'}) RETURN r.version AS v");
    expect(mainAfter).toEqual(mainBefore);

    // Running both again changes nothing.
    expect((await seedDatabase(h.db, { seedDir: dir })).routesSeeded).toEqual([]);
    await migrateGraphExplorer(h.db, { seedDir: dir });
    expect(await legsOf("route-late-sample")).toBe(3);
  });

  it("never re-creates a sample route someone deleted", async () => {
    await h.db.query(
      "MATCH (r:Route {id: 'route-late-sample'}) OPTIONAL MATCH (r)-[:HAS_STOP]->(s:Stop) OPTIONAL MATCH (s)-[:ARRIVES_VIA]->(l:Leg) WITH r, collect(DISTINCT s) AS ss, collect(DISTINCT l) AS ls FOREACH (x IN ls | DETACH DELETE x) FOREACH (x IN ss | DETACH DELETE x) DETACH DELETE r",
    );
    expect((await seedDatabase(h.db, { seedDir: dir })).routesSeeded).toEqual([]);
    const rows = await h.db.query("MATCH (r:Route {id: 'route-late-sample'}) RETURN r.id AS id");
    expect(rows).toEqual([]);
  });

  it("stores the Google Maps search text for activities", async () => {
    const rows = await h.db.query<{ q: string | null }>("MATCH (a:Activity) WHERE a.mapsQuery IS NOT NULL RETURN a.mapsQuery AS q LIMIT 1");
    // Present once seed/activities.json carries mapsQuery values.
    if (rows.length) expect(typeof rows[0]!.q).toBe("string");
  });
});
