import type { ActivityRef, Country, RouteRef, StopActivity, TripRef } from "@trippr/contracts";
import type { ArriveMode as ArriveModeName, VisaRule, When } from "@trippr/rules";
import type { GraphClient } from "../db/graph";
import { newId, nowIso } from "../ids";
import { cypher } from "./queries";
import { num, optNum, parseJson, present, str } from "./util";

/** One stop as stored, before dates are computed. */
export interface StoredStop {
  id: string;
  order: number;
  nights: number;
  arriveMode: ArriveModeName;
  arriveNote: string | null;
  notes: string | null;
  city: { code: string; name: string; lat: number; lon: number };
  country: Country & { color?: string | null };
  planned: ActivityRef[];
}

export interface StoredRoute {
  route: RouteRef;
  trip: TripRef;
  stops: StoredStop[];
}

type RawStop = {
  stop: Record<string, unknown>;
  city: { code: string; name: string; lat: number; lon: number };
  country: { iso: string; name: string; visaRule: unknown; color?: string | null };
  planned: { id: string | null; title: string; when: unknown; costCad: unknown; day: unknown }[];
};

type RawMeta = {
  route: { id: string; name: string; tags: string[] | null; isCurrent: boolean | null; version: number; createdAt: string };
  trip: TripRef;
  derivedFrom: { id: string | null; name: string | null } | null;
};

export function routesRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const read = { readOnly: true };

  /** Runs a version-guarded write; returns the new version, or null on a version mismatch. */
  async function guarded(name: string, params: Record<string, unknown>): Promise<number | null> {
    const [row] = await db.query<{ version: number }>(q(name), params);
    return row ? num(row.version) : null;
  }

  return {
    async load(routeId: string): Promise<StoredRoute | null> {
      const [meta] = await db.query<RawMeta>(q("routes/meta"), { routeId }, read);
      if (!meta) return null;
      const [loaded] = await db.query<{ stops: RawStop[] }>(q("routes/load"), { routeId }, read);
      const derived = present(meta.derivedFrom, "id");
      const stops = (loaded?.stops ?? [])
        .filter((s) => s && s.stop && s.stop.id != null)
        .map(
          (s): StoredStop => ({
            id: String(s.stop.id),
            order: num(s.stop.order),
            nights: num(s.stop.nights),
            arriveMode: (str(s.stop.arriveMode) ?? "flight") as ArriveModeName,
            arriveNote: str(s.stop.arriveNote),
            notes: str(s.stop.notes),
            city: { code: s.city.code, name: s.city.name, lat: num(s.city.lat), lon: num(s.city.lon) },
            country: {
              iso: s.country.iso,
              name: s.country.name,
              visaRule: parseJson<VisaRule>(s.country.visaRule),
              color: s.country.color ?? null,
            },
            planned: (s.planned ?? [])
              .filter((p) => p && p.id != null)
              .map((p) => ({
                id: String(p.id),
                title: p.title,
                when: parseJson<When>(p.when),
                costCad: optNum(p.costCad),
                day: optNum(p.day),
              }))
              .sort((a, b) => a.title.localeCompare(b.title)),
          }),
        )
        .sort((a, b) => a.order - b.order);
      return {
        route: {
          id: meta.route.id,
          name: meta.route.name,
          tags: meta.route.tags ?? [],
          isCurrent: Boolean(meta.route.isCurrent),
          version: num(meta.route.version),
          createdAt: meta.route.createdAt,
          derivedFrom: derived ? { id: String(derived.id), name: String(derived.name) } : null,
        },
        trip: meta.trip,
        stops,
      };
    },

    async library(routeId: string, userId: string) {
      const rows = await db.query<{
        stopId: string;
        cityCode: string;
        cityName: string;
        activity: { id: string; title: string; when: unknown; url: string | null; costCad: unknown };
        planned: boolean;
        votes: number;
        myVote: number;
        tags: string[];
        commentCount: number;
      }>(q("routes/library"), { routeId, userId }, read);
      const byStop = new Map<string, { cityCode: string; activities: StopActivity[] }>();
      for (const r of rows) {
        const entry = byStop.get(r.stopId) ?? { cityCode: r.cityCode, activities: [] };
        entry.activities.push({
          id: r.activity.id,
          title: r.activity.title,
          when: parseJson<When>(r.activity.when),
          url: r.activity.url ?? null,
          costCad: optNum(r.activity.costCad),
          tags: [...(r.tags ?? [])].sort(),
          cityCode: r.cityCode,
          cityName: r.cityName,
          votes: num(r.votes),
          myVote: Math.sign(num(r.myVote)) as -1 | 0 | 1,
          commentCount: num(r.commentCount),
          planned: Boolean(r.planned),
        });
        byStop.set(r.stopId, entry);
      }
      return byStop;
    },

    async create(tripId: string, name: string, tags: string[]) {
      const id = newId("rt");
      await db.query(q("routes/create"), { tripId, id, name, tags, now: nowIso() });
      return id;
    },

    async duplicate(source: StoredRoute, name: string, tags: string[]) {
      const id = newId("rt");
      await db.query(q("routes/duplicate"), {
        fromRouteId: source.route.id,
        id,
        name,
        tags,
        now: nowIso(),
        stops: source.stops.map((s, i) => ({
          id: newId("st"),
          order: i,
          cityCode: s.city.code,
          nights: s.nights,
          arriveMode: s.arriveMode,
          arriveNote: s.arriveNote,
          notes: s.notes,
          plans: s.planned.map((p) => ({ activityId: p.id, day: p.day ?? null })),
        })),
      });
      return id;
    },

    patch: (routeId: string, version: number, input: { name?: string; tags?: string[]; makeCurrent: boolean }) =>
      guarded("routes/patch", {
        routeId,
        version,
        name: input.name ?? null,
        tags: input.tags ?? null,
        makeCurrent: input.makeCurrent,
      }),

    async delete(routeId: string) {
      await db.query(q("routes/delete"), { routeId });
    },

    addStop: (
      routeId: string,
      version: number,
      stop: { id: string; cityCode: string; nights: number; arriveMode: string; order: number },
      orders: { id: string; order: number }[],
    ) =>
      guarded("stops/add", {
        routeId,
        version,
        stopId: stop.id,
        cityCode: stop.cityCode,
        nights: stop.nights,
        arriveMode: stop.arriveMode,
        order: stop.order,
        orders,
      }),

    reorder: (routeId: string, version: number, orders: { id: string; order: number }[]) =>
      guarded("stops/reorder", { routeId, version, orders }),

    patchStop: (
      stopId: string,
      version: number,
      input: { nights?: number; arriveMode?: string; arriveNote?: string; notes?: string },
    ) =>
      guarded("stops/patch", {
        stopId,
        version,
        nights: input.nights ?? null,
        arriveMode: input.arriveMode ?? null,
        arriveNote: input.arriveNote ?? null,
        notes: input.notes ?? null,
      }),

    deleteStop: (stopId: string, version: number) => guarded("stops/delete", { stopId, version }),

    /** Returns false when the activity is not in the stop's city. */
    async plan(stopId: string, activityId: string, day: number | null) {
      const rows = await db.query(q("stops/plan"), { stopId, activityId, day });
      return rows.length > 0;
    },

    async unplan(stopId: string, activityId: string) {
      await db.query(q("stops/unplan"), { stopId, activityId });
    },

    async compareCities(a: string, b: string) {
      const [row] = await db.query<{ shared: string[]; onlyA: string[]; onlyB: string[] }>(
        q("compare/cities"),
        { a, b },
        read,
      );
      return row ?? { shared: [], onlyA: [], onlyB: [] };
    },

    async nightsByCountry(routeId: string) {
      const rows = await db.query<{ country: string; iso: string; nights: number }>(
        q("compare/nights"),
        { routeId },
        read,
      );
      return rows.map((r) => ({ ...r, nights: num(r.nights) }));
    },
  };
}
