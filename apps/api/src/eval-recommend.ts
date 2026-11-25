/**
 * Offline evaluation of "Suggested for this stop". No database, no network, no key: it reads a bundle and its place vectors from
 * disk and runs the API's own scoring (services/recommend/core.ts) over synthetic groups sampled from the catalogue. See
 * docs/data-platform.md ("Suggested for this stop") for the protocol and what it can and cannot say.
 *
 *   pnpm eval:recommend                                    # the golden bundle with FAKE hashing vectors: a plumbing run
 *   pnpm eval:recommend --bundle pipelines/out/bundles --embeddings pipelines/out/embeddings   # the real catalogue and BGE-M3 vectors
 *
 * Options: --date, --k 10, --max-rank 20, --seed N, --profiles-per-city 4, --repeats 2, --liked 6, --max-cities N,
 * --fake-dims 64 (vectors made in memory when --embeddings is not given), --sweep (rows for other diversity settings), --json,
 * --min-hit10 0.5 (exit 1 below it).
 * It exits 1 when an invariant check fails (a planned place suggested, a missing reason, ...), whatever the vectors.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExistingActivity } from "./repositories/catalogue";
import { openStore, selectBundle } from "./services/catalogue/bundle";
import { readEmbeddingsRun } from "./services/catalogue/embeddings";
import { planLoad } from "./services/catalogue/loader";
import { TUNING, unit } from "./services/recommend/core";
import { DEFAULT_EVAL, renderEval, runEval, viaCore, type EvalOptions, type EvalPlace } from "./services/recommend/eval";
import { fakeVector } from "./services/search/embedder";
import { fakePlaceText } from "./services/search/fake-run";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const num = (name: string, fallback: number) => (arg(name) !== undefined ? Number(arg(name)) : fallback);

const bundleLocation = arg("--bundle") ?? join(ROOT, "pipelines/tests/fixtures/expected/bundle");
const embeddingsLocation = arg("--embeddings");
const store = await openStore(bundleLocation);
const { bundle, skipped } = await selectBundle(store, arg("--date"));
if (!bundle) {
  console.error(`no usable bundle in ${bundleLocation}${skipped.length ? `: ${skipped.map((s) => `${s.date}: ${s.reason}`).join("; ")}` : ""}`);
  process.exit(1);
}

let vectors: Map<string, Float32Array>;
let vectorsFrom: string;
if (embeddingsLocation) {
  const run = await readEmbeddingsRun(await openStore(embeddingsLocation), arg("--embeddings-date") ?? bundle.date);
  const { dims } = run.manifest;
  vectors = new Map(run.placeIds.map((id, row) => [id, unit(run.matrix.subarray(row * dims, (row + 1) * dims))]));
  vectorsFrom = `${run.manifest.model} (${dims} dimensions) from ${embeddingsLocation}`;
} else {
  const dims = num("--fake-dims", 64);
  vectors = new Map(bundle.places.map((p) => [p.id, fakeVector(fakePlaceText(p), dims)]));
  vectorsFrom = `FAKE hashing vectors (${dims} dimensions): a plumbing run, the vectors say nothing about meaning`;
}

const places: EvalPlace[] = bundle.places.flatMap((p) => {
  const vector = vectors.get(p.id);
  if (!vector) return [];
  const e = bundle.enrichment.get(p.id);
  return [
    {
      id: p.id,
      title: p.name_en ?? p.name,
      city: p.city_code,
      category: p.category,
      tag: p.tag,
      rank: p.rank,
      sitelinks: p.wikidata_sitelinks ?? 0,
      nSources: p.n_sources,
      bestTime: e?.best_time ?? null,
      indoor: e?.indoor ?? null,
      vector,
    },
  ];
});

const options: EvalOptions = {
  ...DEFAULT_EVAL,
  k: num("--k", DEFAULT_EVAL.k),
  maxRank: num("--max-rank", DEFAULT_EVAL.maxRank),
  seed: num("--seed", DEFAULT_EVAL.seed),
  profilesPerCity: num("--profiles-per-city", DEFAULT_EVAL.profilesPerCity),
  repeats: num("--repeats", DEFAULT_EVAL.repeats),
  likedPerProfile: num("--liked", DEFAULT_EVAL.likedPerProfile),
  maxCities: num("--max-cities", DEFAULT_EVAL.maxCities),
  minCityPlaces: num("--min-city-places", DEFAULT_EVAL.minCityPlaces),
};

/** What the seeded trip offers a leave-one-out: its votes, its plans, and how many of those planned ideas have a vector. */
function seededTrip() {
  const seed = <T>(name: string) => JSON.parse(readFileSync(join(ROOT, "seed", name), "utf8")) as T;
  const trip = seed<{ routes: string[] }>("trip.json");
  const cities = new Map(seed<{ code: string; name: string }[]>("cities.json").map((c) => [c.code, c.name]));
  const ideas = seed<{ id: string; city: string; title: string; mapsQuery?: string; votes?: unknown }[]>("activities.json");
  const planned = new Set<string>();
  for (const file of trip.routes) for (const stop of seed<{ stops: { plans?: string[] }[] }>(file).stops) for (const id of stop.plans ?? []) planned.add(id);
  const existing: ExistingActivity[] = ideas.map((a) => ({
    id: a.id, title: a.title, mapsQuery: a.mapsQuery ?? null, lat: null, lon: null, placeStatus: "unplaced", geoSource: null,
    catalogue: false, adopted: false, catalogueId: null, sourceKeys: [], listed: true, hidden: false, edited: false, contentHash: null,
    cityCode: a.city, cityName: cities.get(a.city) ?? a.city, votes: 0, plans: 0, comments: 0,
  }));
  const adopted = new Set(planLoad(existing, bundle!, "2026-01-01T00:00:00Z").adopted.map((a) => a.activityId));
  return {
    ideas: ideas.length,
    votes: ideas.filter((a) => a.votes !== undefined).length,
    plannedIdeas: planned.size,
    plannedWithVector: [...planned].filter((id) => adopted.has(id)).length,
  };
}

// --sweep adds rows for other diversity settings, to see what the shipped ones cost and buy.
const sweep = process.argv.includes("--sweep")
  ? [
      ...[0.5, 0.6, 0.85].map((l) => viaCore(`sweep: MMR lambda ${l}`, { ...TUNING, mmrLambda: l }, options.maxRank)),
      viaCore("sweep: no category charge", { ...TUNING, categoryPenalty: 0 }, options.maxRank),
      viaCore("sweep: category charge 0.08", { ...TUNING, categoryPenalty: 0.08 }, options.maxRank),
      viaCore("sweep: average-taste share 0.25", { ...TUNING, centroidShare: 0.25 }, options.maxRank),
      viaCore("sweep: average-taste share 0.75", { ...TUNING, centroidShare: 0.75 }, options.maxRank),
    ]
  : [];
const report = runEval(places, options, sweep);
const seeded = seededTrip();
const title = `# Recommendation eval: ${bundle.date} bundle (${bundle.places.length} places), ${vectorsFrom}`;
const note = [
  "",
  `Seeded trip: ${seeded.ideas} hand-written ideas, ${seeded.votes} votes, ${seeded.plannedIdeas} planned ideas of which ${seeded.plannedWithVector} become a catalogue place with a vector in this bundle. Too few signals for a leave-one-out on it, so the groups above are synthetic (places, categories, ranks and vectors are real; who voted for what is simulated).`,
  "",
].join("\n");

if (process.argv.includes("--json")) console.log(JSON.stringify({ title, seeded, report }, null, 1));
else console.log(renderEval(report, title) + note);

const failed = report.checks.filter((c) => c.kind === "invariant" && !c.ok);
if (failed.length) {
  console.error(`invariant check failed: ${failed.map((c) => c.name).join("; ")}`);
  process.exitCode = 1;
}
const min = arg("--min-hit10");
if (min && report.rows[0]!.hit10 < Number(min)) {
  console.error(`hit@10 ${report.rows[0]!.hit10} is below ${min}`);
  process.exitCode = 1;
}
