import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { GraphBackup } from "./backup";

/**
 * Where daily backups live: a local folder or a Cloud Storage prefix
 * (gs://bucket/prefix). Files are named trippr-YYYY-MM-DD.json.gz, one per day.
 */
export interface BackupStore {
  location: string;
  /** Dates (YYYY-MM-DD) that have a backup, oldest first. */
  dates(): Promise<string[]>;
  write(date: string, backup: GraphBackup): Promise<{ name: string; bytes: number }>;
  read(date: string): Promise<GraphBackup>;
  remove(date: string): Promise<void>;
}

const FILE = /^trippr-(\d{4}-\d{2}-\d{2})\.json(\.gz)?$/;
export const backupFileName = (date: string) => `trippr-${date}.json.gz`;

export function encodeBackup(backup: GraphBackup): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(backup)));
}

/** Reads a gzipped or plain JSON backup (the old weekly workflow wrote plain JSON). */
export function decodeBackup(data: Buffer): GraphBackup {
  const text = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data).toString("utf8") : data.toString("utf8");
  return JSON.parse(text) as GraphBackup;
}

export function localBackupStore(dir: string): BackupStore {
  const nameFor = async (date: string) => {
    const files = await readdir(dir).catch(() => [] as string[]);
    return files.find((f) => FILE.exec(f)?.[1] === date) ?? backupFileName(date);
  };
  return {
    location: dir,
    async dates() {
      const files = await readdir(dir).catch(() => [] as string[]);
      return [...new Set(files.map((f) => FILE.exec(f)?.[1]).filter((d): d is string => Boolean(d)))].sort();
    },
    async write(date, backup) {
      await mkdir(dir, { recursive: true });
      const data = encodeBackup(backup);
      const name = backupFileName(date);
      await writeFile(join(dir, name), data);
      return { name: join(dir, name), bytes: data.length };
    },
    async read(date) {
      return decodeBackup(await readFile(join(dir, await nameFor(date))));
    },
    async remove(date) {
      await rm(join(dir, await nameFor(date)), { force: true });
    },
  };
}

/** The slice of @google-cloud/storage this module uses, so the package stays an optional import. */
export interface GcsBackupClient {
  bucket(name: string): {
    getFiles(options: { prefix: string; autoPaginate: boolean; maxResults?: number }): Promise<[{ name: string }[], ...unknown[]]>;
    file(path: string): {
      save(data: Buffer, options: { contentType: string; resumable: boolean }): Promise<unknown>;
      download(): Promise<[Buffer]>;
      delete(options?: { ignoreNotFound: boolean }): Promise<unknown>;
    };
  };
}

export async function gcsBackupStore(uri: string, loadClient?: () => Promise<GcsBackupClient>): Promise<BackupStore> {
  const m = /^gs:\/\/([^/]+)\/?(.*)$/.exec(uri);
  if (!m) throw new Error(`Not a Cloud Storage location: ${uri}`);
  const [, bucketName, rawPrefix] = m;
  const prefix = rawPrefix ? `${rawPrefix.replace(/\/+$/, "")}/` : "";
  const client = await (loadClient ?? loadGcs)();
  const bucket = client.bucket(bucketName!);
  const list = async () => {
    const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
    return files.map((f) => f.name.slice(prefix.length)).filter((n) => FILE.test(n));
  };
  const nameFor = async (date: string) => (await list()).find((n) => FILE.exec(n)?.[1] === date) ?? backupFileName(date);
  return {
    location: `gs://${bucketName}/${prefix}`,
    async dates() {
      return [...new Set((await list()).map((n) => FILE.exec(n)![1]!))].sort();
    },
    async write(date, backup) {
      const data = encodeBackup(backup);
      const name = `${prefix}${backupFileName(date)}`;
      await bucket.file(name).save(data, { contentType: "application/gzip", resumable: false });
      return { name: `gs://${bucketName}/${name}`, bytes: data.length };
    },
    async read(date) {
      const [data] = await bucket.file(`${prefix}${await nameFor(date)}`).download();
      return decodeBackup(data);
    },
    async remove(date) {
      await bucket.file(`${prefix}${await nameFor(date)}`).delete({ ignoreNotFound: true });
    },
  };
}

async function loadGcs(): Promise<GcsBackupClient> {
  const name = "@google-cloud/storage";
  try {
    const mod = (await import(/* @vite-ignore */ name)) as { Storage: new () => GcsBackupClient };
    return new mod.Storage();
  } catch (error) {
    throw new Error(`Writing backups to Cloud Storage needs the ${name} package: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function openBackupStore(location: string): Promise<BackupStore> {
  return location.startsWith("gs://") ? gcsBackupStore(location) : Promise.resolve(localBackupStore(location));
}
