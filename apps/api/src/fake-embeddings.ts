/**
 * Writes a FAKE embeddings run for a bundle (embeddings/<date>/ in the pipeline's format, made with the fake hashing
 * embedder), so the load job and search can be run without downloading a model. For the end-to-end run and local
 * trials only: the vectors say nothing about meaning. Start the API with SEARCH_EMBEDDER=fake to query them.
 *
 *   tsx src/fake-embeddings.ts --bundle <folder holding bundles/<date>> --out <folder> [--dims 64]
 */
import { openStore, selectBundle } from "./services/catalogue/bundle";
import { writeFakeRun } from "./services/search/fake-run";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const bundleLocation = arg("--bundle");
const out = arg("--out");
if (!bundleLocation || !out) {
  console.error("usage: tsx src/fake-embeddings.ts --bundle <bundles folder> --out <embeddings folder> [--dims 64]");
  process.exit(2);
}
const dims = Number(arg("--dims") ?? 64);
const { bundle } = await selectBundle(await openStore(bundleLocation));
if (!bundle) {
  console.error(`no usable bundle in ${bundleLocation}`);
  process.exit(1);
}
const manifest = writeFakeRun(out, bundle.date, bundle.places, { dims });
console.log(`wrote fake embeddings for ${bundle.date}: ${manifest.count} places, ${dims} dimensions, to ${out}`);
