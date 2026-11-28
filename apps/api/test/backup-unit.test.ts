import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupCounts, backupsToPrune, compareCounts, safeName, type GraphBackup } from "../src/db/backup";
import { decodeBackup, encodeBackup, gcsBackupStore, localBackupStore, type GcsBackupClient } from "../src/db/backup-store";

const sample: GraphBackup = {
  format: 1,
  exportedAt: "2026-11-28T06:00:00.000Z",
  dialect: "falkordb",
  nodes: [
    { id: 1, labels: ["Trip"], props: { id: "t1" } },
    { id: 2, labels: ["Route"], props: { id: "r1", tags: ["main"] } },
    { id: 3, labels: ["Hub", "Station"], props: { hubId: "h1" } },
  ],
  relationships: [{ start: 1, end: 2, type: "HAS_ROUTE", props: {} }],
};

function days(from: string, count: number): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(start - i * 86_400_000).toISOString().slice(0, 10));
}

describe("backupsToPrune", () => {
  it("keeps every backup from the last two weeks", () => {
    expect(backupsToPrune(days("2026-11-28", 14), "2026-11-28")).toEqual([]);
  });

  it("thins older backups to one a week, then one a month", () => {
    const all = days("2026-11-28", 400);
    const prune = new Set(backupsToPrune(all, "2026-11-28"));
    const kept = all.filter((d) => !prune.has(d)).sort();
    // 14 daily; weeks 2-7 back add one each; months not yet covered add one each.
    const recent = kept.filter((d) => d >= "2026-11-15");
    expect(recent).toHaveLength(14);
    const older = kept.filter((d) => d < "2026-11-15");
    // Never more than one per week among the older ones that are weekly.
    expect(older.length).toBeGreaterThanOrEqual(10);
    expect(older.length).toBeLessThanOrEqual(6 + 12);
    // Nothing older than twelve months survives.
    expect(kept.every((d) => d >= "2025-12-01")).toBe(true);
    // The kept backup of a month is that month's newest.
    expect(kept).toContain("2026-02-28");
    expect(kept).not.toContain("2026-02-27");
  });

  it("never deletes names it does not understand or backups dated in the future", () => {
    expect(backupsToPrune(["junk", "2027-01-01", "2020-01-01"], "2026-11-28")).toEqual(["2020-01-01"]);
  });

  it("follows the keep settings", () => {
    const prune = backupsToPrune(days("2026-11-28", 10), "2026-11-28", { daily: 3, weekly: 0, monthly: 0 });
    expect(prune).toHaveLength(7);
    expect(prune).not.toContain("2026-11-26");
  });
});

describe("restore checks", () => {
  it("accepts plain labels and refuses anything that could change the query", () => {
    expect(safeName("Activity")).toBe("Activity");
    expect(() => safeName("A`) DETACH DELETE (n")).toThrow(/unusual/);
    expect(() => safeName("RestoreTmp")).toThrow();
  });

  it("counts labels and types, and explains differences", () => {
    const counts = backupCounts(sample);
    expect(counts).toEqual({ nodes: 3, relationships: 1, labels: { Trip: 1, Route: 1, Hub: 1, Station: 1 }, types: { HAS_ROUTE: 1 } });
    expect(compareCounts(counts, counts)).toEqual([]);
    const fewer = { ...counts, nodes: 2, labels: { ...counts.labels, Route: 0 } };
    expect(compareCounts(counts, fewer)).toEqual(["nodes: expected 3, found 2", ":Route: expected 1, found 0"]);
  });
});

describe("backup files", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("round-trips gzipped and reads the old plain JSON exports", () => {
    expect(decodeBackup(encodeBackup(sample))).toEqual(sample);
    expect(decodeBackup(Buffer.from(JSON.stringify(sample)))).toEqual(sample);
  });

  it("stores one file per day in a folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trippr-backup-"));
    dirs.push(dir);
    const store = localBackupStore(dir);
    await store.write("2026-11-27", sample);
    writeFileSync(join(dir, "trippr-2026-11-20.json"), JSON.stringify(sample));
    writeFileSync(join(dir, "notes.txt"), "not a backup");
    expect(await store.dates()).toEqual(["2026-11-20", "2026-11-27"]);
    expect((await store.read("2026-11-20")).nodes).toHaveLength(3);
    await store.remove("2026-11-20");
    expect(await store.dates()).toEqual(["2026-11-27"]);
  });

  it("writes to and lists a Cloud Storage prefix", async () => {
    const files = new Map<string, Buffer>();
    const client: GcsBackupClient = {
      bucket: () => ({
        getFiles: async ({ prefix }) => [[...files.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }))],
        file: (path) => ({
          save: async (data) => void files.set(path, data),
          download: async () => [files.get(path)!],
          delete: async () => void files.delete(path),
        }),
      }),
    };
    const store = await gcsBackupStore("gs://bucket/graph", async () => client);
    const written = await store.write("2026-11-28", sample);
    expect(written.name).toBe("gs://bucket/graph/trippr-2026-11-28.json.gz");
    expect(await store.dates()).toEqual(["2026-11-28"]);
    expect((await store.read("2026-11-28")).relationships).toHaveLength(1);
    await store.remove("2026-11-28");
    expect(files.size).toBe(0);
  });
});
