import type { City, PathLeg, PathResult } from "@trippr/contracts";
import type { GraphClient } from "../db/graph";
import { cypher } from "./queries";
import { num, optNum } from "./util";

type CityRow = { city: { code: string; name: string; lat: number; lon: number }; countryIso: string; countryName: string };

const toCity = (r: CityRow): City => ({
  code: r.city.code,
  name: r.city.name,
  lat: num(r.city.lat),
  lon: num(r.city.lon),
  countryIso: r.countryIso,
  countryName: r.countryName,
});

/** Modes that count as "a train exists". */
export const RAIL_LINK_MODES = ["hsr", "train", "maglev"];

export function citiesRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const read = { readOnly: true };
  return {
    async search(text: string, limit: number): Promise<City[]> {
      const rows = await db.query<CityRow>(q("cities/search"), { q: text, limit: 200 }, read);
      const needle = text.toLowerCase();
      // Rank exact code, then name prefix, then anything else that matched.
      const rank = (c: City) =>
        c.code.toLowerCase() === needle ? 0 : c.name.toLowerCase().startsWith(needle) ? 1 : 2;
      return rows
        .map(toCity)
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
        .slice(0, limit);
    },

    async get(code: string): Promise<City | null> {
      const [row] = await db.query<CityRow>(q("cities/get"), { code }, read);
      return row ? toCity(row) : null;
    },

    async getMany(codes: string[]): Promise<Map<string, City>> {
      const rows = await db.query<CityRow>(q("cities/get-many"), { codes }, read);
      return new Map(rows.map((r) => [r.city.code, toCity(r)]));
    },

    /** Pathfinding over stored LINK edges (stretch feature 9). */
    async path(from: string, to: string, by: PathResult["by"], railOnly: boolean): Promise<Omit<PathResult, "cities"> & { codes: string[] }> {
      const params = { from, to, weight: by, modes: railOnly ? RAIL_LINK_MODES : [] };
      // Rail-only needs a filter on edge properties, which only the portable query supports.
      const name = railOnly ? "paths/weighted" : by === "hops" ? "paths/hops" : "paths/weighted";
      const text = railOnly ? cypher(name, db.dialect, { portable: true }) : q(name);
      const [row] = await db.query<{ cities: string[]; legs: Record<string, unknown>[] }>(text, params, {
        readOnly: true,
      });
      if (!row || !row.cities?.length) {
        return { found: false, by, railOnly, codes: [], legs: [], totalMinutes: null, totalCostCad: null };
      }
      const legs: PathLeg[] = row.legs.map((e, i) => ({
        from: row.cities[i]!,
        to: row.cities[i + 1]!,
        mode: String(e.mode),
        minutes: optNum(e.minutes),
        costCad: optNum(e.costCad),
        source: (e.source as string | null) ?? null,
        asOf: (e.asOf as string | null) ?? null,
      }));
      const sum = (key: "minutes" | "costCad") =>
        legs.every((l) => l[key] != null) ? legs.reduce((t, l) => t + (l[key] ?? 0), 0) : null;
      return {
        found: true,
        by,
        railOnly,
        codes: row.cities,
        legs,
        totalMinutes: sum("minutes"),
        totalCostCad: sum("costCad"),
      };
    },
  };
}
