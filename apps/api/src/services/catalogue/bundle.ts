import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  BUNDLE_FILES,
  bundleEnrichmentSchema,
  bundleManifestSchema,
  bundlePlaceSchema,
  bundleSourceInfoSchema,
  type BundleEnrichment,
  type BundleManifest,
  type BundlePlace,
  type BundleSourceInfo,
} from "@trippr/contracts";

/** Where bundles live: a folder of bundles/<date>/ directories, on disk or in a Cloud Storage bucket. */
export interface BundleStore {
  readonly location: string;
  /** Bundle dates (YYYY-MM-DD) present, oldest first. */
  dates(): Promise<string[]>;
  read(date: string, file: string): Promise<Buffer>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function localStore(root: string): BundleStore {
  return {
    location: root,
    async dates() {
      const entries = await readdir(root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && DATE.test(e.name)).map((e) => e.name).sort();
    },
    read: (date, file) => readFile(join(root, date, file)),
  };
}

/** The slice of @google-cloud/storage this module uses, so the package stays an optional import. */
interface GcsClient {
  bucket(name: string): {
    getFiles(options: { prefix: string; delimiter: string; autoPaginate: boolean }): Promise<[unknown[], unknown, { prefixes?: string[] }?]>;
    file(path: string): { download(): Promise<[Buffer]> };
  };
}

/** gs://bucket/prefix (the prefix is the folder holding the dated bundle folders, default "bundles"). */
export async function gcsStore(uri: string, loadClient?: () => Promise<GcsClient>): Promise<BundleStore> {
  const m = /^gs:\/\/([^/]+)\/?(.*)$/.exec(uri);
  if (!m) throw new Error(`Not a Cloud Storage location: ${uri}`);
  const [, bucketName, rawPrefix] = m;
  const prefix = `${(rawPrefix || "bundles").replace(/\/+$/, "")}/`;
  const client = await (loadClient ?? loadGcs)();
  const bucket = client.bucket(bucketName!);
  return {
    location: `gs://${bucketName}/${prefix}`,
    async dates() {
      const [, , apiResponse] = await bucket.getFiles({ prefix, delimiter: "/", autoPaginate: false });
      return (apiResponse?.prefixes ?? [])
        .map((p) => p.slice(prefix.length).replace(/\/$/, ""))
        .filter((d) => DATE.test(d))
        .sort();
    },
    async read(date, file) {
      const [data] = await bucket.file(`${prefix}${date}/${file}`).download();
      return data;
    },
  };
}

async function loadGcs(): Promise<GcsClient> {
  const name = "@google-cloud/storage";
  try {
    const mod = (await import(/* @vite-ignore */ name)) as { Storage: new () => GcsClient };
    return new mod.Storage();
  } catch (error) {
    throw new Error(`Reading bundles from Cloud Storage needs the ${name} package: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function openStore(location: string): Promise<BundleStore> {
  return location.startsWith("gs://") ? gcsStore(location) : localStore(location);
}

export interface LoadedBundle {
  date: string;
  manifest: BundleManifest;
  places: BundlePlace[];
  sources: BundleSourceInfo[];
  /** LLM enrichment by place id; empty when the bundle has none. */
  enrichment: Map<string, BundleEnrichment>;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Read one bundle and check it: manifest valid, checks passed, every file's checksum, rows and counts. Throws why not. */
export async function readBundle(store: BundleStore, date: string): Promise<LoadedBundle> {
  const manifest = bundleManifestSchema.parse(JSON.parse((await store.read(date, BUNDLE_FILES.manifest)).toString("utf8")));
  if (!manifest.checks.passed) {
    const failed = manifest.checks.results.filter((r) => r.status === "fail").map((r) => r.name);
    throw new Error(`its quality checks did not pass (${failed.join(", ") || "unknown"})`);
  }
  const files = new Map<string, Buffer>();
  for (const f of manifest.files) {
    const data = await store.read(date, f.name);
    if (data.length !== f.bytes || sha256(data) !== f.sha256) throw new Error(`${f.name} does not match its checksum in the manifest`);
    files.set(f.name, data);
  }
  const placesFile = files.get(BUNDLE_FILES.places);
  const sourcesFile = files.get(BUNDLE_FILES.sources);
  if (!placesFile || !sourcesFile) throw new Error("the manifest does not list places and sources files");
  const places = gunzipSync(placesFile)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => bundlePlaceSchema.parse(JSON.parse(line)));
  const sources = (JSON.parse(sourcesFile.toString("utf8")) as unknown[]).map((s) => bundleSourceInfoSchema.parse(s));
  if (places.length !== manifest.counts.places) throw new Error(`${places.length} places, but the manifest says ${manifest.counts.places}`);
  if (new Set(places.map((p) => p.id)).size !== places.length) throw new Error("place ids are not unique");
  const known = new Set(sources.map((s) => s.id));
  const unknown = places.flatMap((p) => p.sources.map((s) => s.source)).filter((s) => !known.has(s));
  if (unknown.length) throw new Error(`places cite sources missing from sources.json: ${[...new Set(unknown)].join(", ")}`);
  return { date, manifest, places, sources, enrichment: readEnrichment(files.get(BUNDLE_FILES.enrichment), manifest, places) };
}

/** The optional enrichment file, checked against the places and the manifest. Nothing here may be an unlabelled AI summary. */
function readEnrichment(file: Buffer | undefined, manifest: BundleManifest, places: BundlePlace[]): Map<string, BundleEnrichment> {
  const out = new Map<string, BundleEnrichment>();
  if (!file) {
    if (manifest.enrichment) throw new Error("the manifest describes enrichment, but the bundle has no enrichment file");
    return out;
  }
  const ids = new Set(places.map((p) => p.id));
  for (const line of gunzipSync(file).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const item = bundleEnrichmentSchema.parse(JSON.parse(line));
    if (!ids.has(item.id)) throw new Error(`enrichment for ${item.id}, which is not a place in the bundle`);
    if (out.has(item.id)) throw new Error(`enrichment for ${item.id} appears twice`);
    if (item.summary && !(item.ai && item.provenance.summary_ai && item.ai_label)) {
      throw new Error(`${item.id} has a summary that is not marked as written by AI`);
    }
    out.set(item.id, item);
  }
  if (manifest.enrichment && manifest.enrichment.places !== out.size) {
    throw new Error(`${out.size} enriched places, but the manifest says ${manifest.enrichment.places}`);
  }
  return out;
}

export interface BundleChoice {
  bundle: LoadedBundle | null;
  /** Newer bundles that were passed over, and why. */
  skipped: { date: string; reason: string }[];
}

/** The newest bundle that passed its checks and verifies, or a specific `date`. */
export async function selectBundle(store: BundleStore, date?: string): Promise<BundleChoice> {
  const dates = date ? [date] : (await store.dates()).reverse();
  const skipped: BundleChoice["skipped"] = [];
  for (const d of dates) {
    try {
      return { bundle: await readBundle(store, d), skipped };
    } catch (error) {
      skipped.push({ date: d, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { bundle: null, skipped };
}
