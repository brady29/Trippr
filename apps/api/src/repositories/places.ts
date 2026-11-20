import type { GraphClient } from "../db/graph";
import { nowIso } from "../ids";
import { cypher } from "./queries";
import { optNum } from "./util";

export interface CachedGeocode {
  found: boolean;
  lat: number | null;
  lon: number | null;
  address: string | null;
  osmId: string | null;
  fetchedAt: string;
}

/** Remembered geocoder answers, so the same place is never asked for twice in a row. */
export function placesRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  return {
    async cached(key: string): Promise<CachedGeocode | null> {
      const [row] = await db.query<{ hit: Record<string, unknown> | null }>(q("places/cache-get"), { key }, { readOnly: true });
      const hit = row?.hit;
      if (!hit || hit.fetchedAt == null) return null;
      return {
        found: Boolean(hit.found),
        lat: optNum(hit.lat),
        lon: optNum(hit.lon),
        address: (hit.address as string | null) ?? null,
        osmId: (hit.osmId as string | null) ?? null,
        fetchedAt: String(hit.fetchedAt),
      };
    },
    async remember(key: string, value: Omit<CachedGeocode, "fetchedAt">) {
      await db.query(q("places/cache-set"), { key, ...value, now: nowIso() });
    },
  };
}
