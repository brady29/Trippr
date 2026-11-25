import type { GraphClient } from "../db/graph";
import { cypher } from "./queries";
import { num, optNum } from "./util";

/** What the suggestions service reads from the graph. Never a vector: those come from the search matrix. */

export interface StopCity {
  tripId: string;
  routeId: string;
  cityCode: string;
  cityName: string;
}

/** One activity of the trip in the stop's city, with the group's signals on it. */
export interface CityActivity {
  id: string;
  title: string;
  /** From the data pipeline's catalogue (not one of the group's own ideas). */
  catalogue: boolean;
  /** False for a catalogue place the latest bundle dropped. */
  listed: boolean;
  category: string | null;
  rank: number | null;
  score: number | null;
  bestTime: string | null;
  indoor: boolean | null;
  /** Who voted and how (-1 or 1). */
  votes: { userId: string; value: number }[];
  planCount: number;
  commentCount: number;
  tags: string[];
}

export interface TagWeight {
  tag: string;
  weight: number;
}

type ActivityRow = {
  id: string;
  title: string;
  catalogue: unknown;
  listed: unknown;
  category: string | null;
  rank: unknown;
  score: unknown;
  bestTime: string | null;
  indoor: unknown;
  votes: { userId: string | null; value: unknown }[] | null;
  planCount: unknown;
  commentCount: unknown;
  tags: string[] | null;
};

export function recommendRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const read = { readOnly: true };

  return {
    /** The stop's trip and city, or null when there is no such stop. */
    async stop(stopId: string): Promise<StopCity | null> {
      const [row] = await db.query<StopCity>(q("recommend/stop"), { stopId }, read);
      return row ? { tripId: row.tripId, routeId: row.routeId, cityCode: row.cityCode, cityName: row.cityName } : null;
    },

    /** Every visible activity of the trip in a city with its votes, plans and comments. */
    async cityActivities(tripId: string, cityCode: string): Promise<CityActivity[]> {
      const rows = await db.query<ActivityRow>(q("recommend/city-activities"), { tripId, cityCode }, read);
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        catalogue: r.catalogue === true,
        listed: r.listed !== false,
        category: r.category ?? null,
        rank: optNum(r.rank),
        score: optNum(r.score),
        bestTime: r.bestTime ?? null,
        indoor: typeof r.indoor === "boolean" ? r.indoor : null,
        votes: (r.votes ?? [])
          .filter((v) => v && v.userId != null && v.value != null)
          .map((v) => ({ userId: String(v.userId), value: Math.sign(num(v.value)) })),
        planCount: num(r.planCount),
        commentCount: num(r.commentCount),
        tags: [...(r.tags ?? [])],
      }));
    },

    /** The colour tags the group liked in the trip's other cities (net votes, plus one for each planned place with the tag). */
    async tagPreferences(tripId: string, cityCode: string): Promise<TagWeight[]> {
      const [votes, plans] = await Promise.all([
        db.query<{ tag: string; weight: unknown }>(q("recommend/tag-votes"), { tripId, cityCode }, read),
        db.query<{ tag: string; places: unknown }>(q("recommend/tag-plans"), { tripId, cityCode }, read),
      ]);
      const totals = new Map<string, number>();
      for (const v of votes) totals.set(v.tag, (totals.get(v.tag) ?? 0) + num(v.weight));
      for (const p of plans) totals.set(p.tag, (totals.get(p.tag) ?? 0) + num(p.places));
      return [...totals].map(([tag, weight]) => ({ tag, weight })).sort((a, b) => b.weight - a.weight || a.tag.localeCompare(b.tag));
    },
  };
}

export type RecommendRepository = ReturnType<typeof recommendRepository>;
