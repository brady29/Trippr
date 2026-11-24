import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BundlePlace, EmbeddingsManifest } from "@trippr/contracts";
import { fakeVector } from "./embedder";

/**
 * A fake embeddings run in the pipeline's format (manifest.json, embeddings.f32, ids.json), made with the fake
 * embedder instead of a model. For the API's tests and the end-to-end run (SEARCH_EMBEDDER=fake): they exercise the
 * whole load and search path without downloading BGE-M3. Not a stand-in for search quality.
 */

/** What the fake embeds for a place: its names, category and description. */
export function fakePlaceText(p: Pick<BundlePlace, "name" | "name_en" | "name_local" | "category" | "description">): string {
  return [p.name_en, p.name, p.name_local, p.category.replace(/_/g, " "), p.description].filter(Boolean).join(" · ");
}

export interface FakeRunOptions {
  dims?: number;
  /** Recorded in the manifest; must start with "fake" for the fake query embedder to accept it. */
  model?: string;
  version?: string;
  /** Replace the text the fake embeds for a place (tests that need two places to look alike). */
  text?: (p: BundlePlace) => string;
  /** Leave these places without a vector. */
  skip?: (p: BundlePlace) => boolean;
  /** Make the run's checksum lie (tests the refusal). */
  corrupt?: "matrix" | "ids";
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Write embeddings/<date>/ under `root` and return the manifest. */
export function writeFakeRun(root: string, date: string, places: BundlePlace[], options: FakeRunOptions = {}): EmbeddingsManifest {
  const dims = options.dims ?? 64;
  const rows = places.filter((p) => !options.skip?.(p));
  const matrix = new Float32Array(rows.length * dims);
  rows.forEach((p, i) => matrix.set(fakeVector((options.text ?? fakePlaceText)(p), dims), i * dims));
  const matrixFile = Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength);
  const hashes = rows.map((p) => sha(Buffer.from(`${options.model ?? `fake-${dims}`}|${options.version ?? "1"}|${(options.text ?? fakePlaceText)(p)}`)));
  const idsFile = Buffer.from(JSON.stringify({ place_ids: rows.map((p) => p.id), content_hashes: hashes }), "utf8");
  const manifest = {
    stage: "embed" as const,
    model: options.model ?? `fake-${dims}`,
    version: options.version ?? "1",
    dims,
    normalized: true as const,
    similarity: "cosine" as const,
    doc_prefix: "",
    query_prefix: "",
    text_version: "v1",
    count: rows.length,
    computed: rows.length,
    cache_hits: 0,
    input: "test",
    created_at: `${date}T12:00:00+00:00`,
    vectors_file: "embeddings.parquet",
    // No Parquet is written (Node never reads it); the field only has to look like a checksum.
    vectors_sha256: sha(Buffer.from("not written")),
    matrix_file: "embeddings.f32",
    matrix_sha256: sha(matrixFile),
    ids_file: "ids.json",
    ids_sha256: sha(idsFile),
  };
  const dir = join(root, date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "embeddings.f32"), options.corrupt === "matrix" ? Buffer.concat([matrixFile.subarray(0, matrixFile.length - 4), Buffer.alloc(4, 1)]) : matrixFile);
  writeFileSync(join(dir, "ids.json"), options.corrupt === "ids" ? Buffer.from(idsFile.toString("utf8").replace("cat-", "cat_"), "utf8") : idsFile);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest as EmbeddingsManifest;
}
