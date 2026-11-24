import { createHash } from "node:crypto";
import { endianness } from "node:os";
import {
  EMBEDDINGS_MANIFEST_FILE,
  embeddingsIdsSchema,
  embeddingsManifestSchema,
  modelFamily,
  type BundlePlace,
  type EmbeddingsManifest,
} from "@trippr/contracts";
import { nowIso } from "../../ids";
import type { Repositories } from "../../repositories";
import type { IndexState } from "../../repositories/search";
import type { BundleStore } from "./bundle";

/**
 * Loading place vectors into the graph (docs/data-platform.md, "Semantic search"). The pipeline's `embed` stage writes
 * embeddings/<date>/ next to bundles/<date>/: a manifest, the Parquet its own tools read, and a sidecar this reads
 * (embeddings.f32, ids.json) so Node needs no Parquet library. Everything is checked before anything is written.
 */

export interface EmbeddingsRun {
  date: string;
  manifest: EmbeddingsManifest;
  placeIds: string[];
  contentHashes: string[];
  /** count x dims, row-major, rows in the order of placeIds. */
  matrix: Float32Array;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Read and verify one embeddings run: manifest valid, files match their checksums and sizes, ids unique, values finite. */
export async function readEmbeddingsRun(store: BundleStore, date: string): Promise<EmbeddingsRun> {
  if (endianness() !== "LE") throw new Error("The embeddings file is little-endian float32; this machine is big-endian");
  const manifest = embeddingsManifestSchema.parse(JSON.parse((await store.read(date, EMBEDDINGS_MANIFEST_FILE)).toString("utf8")));
  const idsFile = await store.read(date, manifest.ids_file);
  if (sha256(idsFile) !== manifest.ids_sha256) throw new Error(`${manifest.ids_file} does not match its checksum in the manifest`);
  const matrixFile = await store.read(date, manifest.matrix_file);
  if (sha256(matrixFile) !== manifest.matrix_sha256) throw new Error(`${manifest.matrix_file} does not match its checksum in the manifest`);

  const ids = embeddingsIdsSchema.parse(JSON.parse(idsFile.toString("utf8")));
  const { count, dims } = manifest;
  if (ids.place_ids.length !== count || ids.content_hashes.length !== count) {
    throw new Error(`${manifest.ids_file} lists ${ids.place_ids.length} places, but the manifest says ${count}`);
  }
  if (new Set(ids.place_ids).size !== count) throw new Error("place ids in the embeddings are not unique");
  if (matrixFile.length !== count * dims * 4) {
    throw new Error(`${manifest.matrix_file} is ${matrixFile.length} bytes, but ${count} vectors of ${dims} float32 values are ${count * dims * 4}`);
  }
  // Copy: a Buffer's memory is not aligned for Float32Array.
  const matrix = new Float32Array(matrixFile.buffer.slice(matrixFile.byteOffset, matrixFile.byteOffset + matrixFile.length));
  for (let i = 0; i < matrix.length; i++) {
    if (!Number.isFinite(matrix[i]!)) throw new Error(`${manifest.matrix_file} holds a value that is not a number (row ${Math.floor(i / dims)})`);
  }
  return { date, manifest, placeIds: ids.place_ids, contentHashes: ids.content_hashes, matrix };
}

export interface Coverage {
  /** Bundle places that have a vector in this run. */
  covered: number;
  /** Bundle places without one: loaded, but found by words only. */
  missing: number;
  /** Vectors for places the bundle does not have (ignored). */
  extra: number;
}

/** How a run lines up with a bundle's place ids. Throws when they have nothing in common (a run for another bundle). */
export function checkCoverage(run: EmbeddingsRun, places: Pick<BundlePlace, "id">[]): Coverage {
  const have = new Set(run.placeIds);
  const covered = places.filter((p) => have.has(p.id)).length;
  if (places.length > 0 && covered === 0) {
    throw new Error(`none of the bundle's ${places.length} places has a vector in the embeddings of ${run.date} (is it a run for another bundle?)`);
  }
  const wanted = new Set(places.map((p) => p.id));
  return { covered, missing: places.length - covered, extra: run.placeIds.filter((id) => !wanted.has(id)).length };
}

/** Why the vectors in the graph cannot be mixed with this run, or null when they can. */
export function conflictWith(loaded: IndexState | null, manifest: EmbeddingsManifest): string | null {
  if (!loaded) return null;
  if (loaded.dims !== manifest.dims) {
    return `the graph holds ${loaded.dims}-dimension vectors (${loaded.model}), but this run has ${manifest.dims} (${manifest.model})`;
  }
  if (modelFamily(loaded.model) !== modelFamily(manifest.model)) {
    return `the graph holds vectors from ${loaded.model}, but this run is from ${manifest.model}`;
  }
  return null;
}

export interface EmbeddingsSummary {
  date: string;
  model: string;
  dims: number;
  dryRun: boolean;
  /** Vectors in the run for places in the bundle. */
  covered: number;
  missing: number;
  /** Vectors written (new or changed). */
  written: number;
  unchanged: number;
  /** The index was dropped and rebuilt (model or size changed, or --rebuild-index). */
  rebuilt: boolean;
}

export interface LoadEmbeddingsOptions {
  rebuildIndex?: boolean;
  dryRun?: boolean;
  now?: () => string;
}

/** Throw before anything is written when the run cannot be loaded as it is. */
export async function preflightEmbeddings(repos: Repositories, run: EmbeddingsRun, places: Pick<BundlePlace, "id">[], options: LoadEmbeddingsOptions) {
  const coverage = checkCoverage(run, places);
  const conflict = conflictWith(await repos.search.indexState(), run.manifest);
  if (conflict && !options.rebuildIndex) {
    throw new Error(`Refusing to load the embeddings of ${run.date}: ${conflict}. Vectors from different models cannot be searched together. Re-run with --rebuild-index to drop the vector index and every stored vector and load this run.`);
  }
  return { coverage, rebuild: Boolean(options.rebuildIndex) || conflict !== null };
}

/**
 * Put the run's vectors on the catalogue Activity nodes (after loadBundle, so the activities exist). Only vectors whose
 * content hash changed are written. Creates the vector index first (idempotent), waits for it where the database
 * builds it in the background, then records what is loaded. `--rebuild-index` drops the index and every vector first.
 */
export async function loadEmbeddings(
  repos: Repositories,
  run: EmbeddingsRun,
  places: Pick<BundlePlace, "id">[],
  options: LoadEmbeddingsOptions & { bundleDate: string },
): Promise<EmbeddingsSummary> {
  const { manifest } = run;
  const { coverage, rebuild } = await preflightEmbeddings(repos, run, places, options);
  const base = { date: run.date, model: manifest.model, dims: manifest.dims, dryRun: Boolean(options.dryRun), covered: coverage.covered, missing: coverage.missing };

  const index = new Map(run.placeIds.map((id, i) => [id, i]));
  const graph = await repos.search.embeddingState();
  const wanted = new Set(places.map((p) => p.id));
  const todo = graph.filter((g) => wanted.has(g.placeId) && index.has(g.placeId));
  const changed = todo.filter((g) => rebuild || g.hash !== run.contentHashes[index.get(g.placeId)!]);
  if (options.dryRun) return { ...base, written: changed.length, unchanged: todo.length - changed.length, rebuilt: rebuild };

  if (rebuild) {
    await repos.search.dropVectorIndex();
    await repos.search.clearEmbeddings();
    await repos.search.forgetIndexState();
  }
  await repos.search.ensureVectorIndex(manifest.dims);
  const { dims } = manifest;
  const written = await repos.search.writeEmbeddings(
    changed.map((g) => {
      const row = index.get(g.placeId)!;
      return { activityId: g.id, hash: run.contentHashes[row]!, vector: run.matrix.subarray(row * dims, (row + 1) * dims) };
    }),
  );
  await repos.search.awaitVectorIndex();

  const loadedAt = (options.now ?? nowIso)();
  const total = (await repos.search.embeddingState()).filter((g) => g.hash !== null).length;
  const before = rebuild ? null : await repos.search.indexState();
  // The revision moves only when vectors changed, so the API's in-memory copy reloads when it must and not otherwise.
  const same = before !== null && written === 0 && before.count === total && before.dims === dims && before.model === manifest.model;
  await repos.search.setIndexState({
    model: manifest.model,
    version: manifest.version,
    dims,
    textVersion: manifest.text_version,
    count: total,
    bundleDate: options.bundleDate,
    loadedAt: same ? before.loadedAt : loadedAt,
    revision: same ? before.revision : `${manifest.model}:${manifest.matrix_sha256.slice(0, 12)}:${total}:${written}:${loadedAt}`,
  });
  return { ...base, written, unchanged: todo.length - changed.length, rebuilt: rebuild };
}

/**
 * Where the embeddings of a bundle location live: next to it, as embeddings/ beside bundles/.
 * "gs://bucket/bundles" -> "gs://bucket/embeddings", "pipelines/out/bundles" -> "pipelines/out/embeddings".
 */
export function defaultEmbeddingsLocation(bundleLocation: string): string | null {
  const m = /^(?:(.*?)[\\/]+)?bundles[\\/]*$/.exec(bundleLocation);
  return m ? (m[1] ? `${m[1]}/embeddings` : "embeddings") : null;
}
