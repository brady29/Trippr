/** JSON properties (Activity.when, Country.visaRule) are stored as strings for portability. */
export function parseJson<T>(value: unknown): T | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export const toJson = (value: unknown) => (value == null ? null : JSON.stringify(value));

/**
 * A map projection of a missing OPTIONAL MATCH is null in Neo4j but may be a
 * map of nulls in some FalkorDB versions. Treat both as "absent".
 */
export function present<T extends object>(map: T | null | undefined, key: keyof T): T | null {
  return map && map[key] != null ? map : null;
}

export const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const optNum = (value: unknown): number | null => (value == null ? null : num(value));

export const str = (value: unknown): string | null => (value == null ? null : String(value));
