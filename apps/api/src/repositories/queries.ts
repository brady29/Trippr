import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Dialect } from "../db/graph";

/**
 * Every Cypher statement lives in a .cypher file under ./cypher/<aggregate>/.
 * A dialect-specific file (name.neo4j.cypher or name.falkordb.cypher) wins
 * over the portable one, so swapping databases only touches this folder.
 *
 * After bundling, this module sits in dist/ and the build copies the folder
 * to dist/cypher, so the same relative URL works in both places.
 */
const CYPHER_DIR = process.env.CYPHER_DIR ?? fileURLToPath(new URL("./cypher/", import.meta.url));

const cache = new Map<string, string>();

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function cypher(name: string, dialect: Dialect, options: { portable?: boolean } = {}): string {
  const key = `${options.portable ? "portable" : dialect}:${name}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const text =
    (options.portable ? undefined : readIfExists(join(CYPHER_DIR, `${name}.${dialect}.cypher`))) ??
    readIfExists(join(CYPHER_DIR, `${name}.cypher`));
  if (text === undefined) throw new Error(`Missing Cypher file for "${name}" in ${CYPHER_DIR}`);
  const trimmed = text.trim();
  cache.set(key, trimmed);
  return trimmed;
}

/** Load every portable query once at startup so a missing file fails fast. */
export function preloadQueries(dialect: Dialect): number {
  let count = 0;
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`);
      else if (/^[\w-]+\.cypher$/.test(entry)) {
        cypher(`${prefix}${entry.replace(/\.cypher$/, "")}`, dialect);
        count++;
      }
    }
  };
  walk(CYPHER_DIR, "");
  return count;
}
