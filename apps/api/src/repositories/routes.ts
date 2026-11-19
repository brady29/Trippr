import type {
  ActivityRef,
  Country,
  Hub,
  Leg,
  LegMode,
  LegStatus,
  RouteRef,
  StayStatus,
  StopActivity,
  StopStay,
  TripRef,
} from "@trippr/contracts";
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
  stayCadPerNight: number | null;
  arriveCostCad: number | null;
  city: { code: string; name: string; lat: number; lon: number };
  country: Country & { color?: string | null };
  planned: ActivityRef[];
  /** Includes bookingRef and seat; route-view strips them before anything is sent. */
  legs: StoredLeg[];
  stays: StoredStay[];
}

export interface StoredLeg extends Omit<Leg, "from" | "to"> {
  from: Hub;
  to: Hub;
  bookingRef: string | null;
  seat: string | null;
}

export interface StoredStay {
  status: StayStatus;
  rooms: number | null;
  arrive: string | null;
  depart: string | null;
  hotel: StopStay["hotel"];
}

type RawHub = Record<string, unknown>;

export const toHub = (h: RawHub): Hub => ({
  kind: (str(h.kind) ?? "station") as Hub["kind"],
  id: String(h.hubId),
  code: str(h.code),
  name: String(h.name),
  nameLocal: str(h.nameLocal),
  stationKind: str(h.stationKind),
  lat: num(h.lat),
  lon: num(h.lon),
  cityCode: str(h.cityCode) ?? "",
  cityName: str(h.cityName) ?? "",
});

/** Stop.arriveMode only knows these modes; a maglev leg counts as a train. */
export const arriveModeFor = (mode: string): ArriveModeName =>
  (["flight", "hsr", "train", "road", "boat"].includes(mode) ? mode : "train") as ArriveModeName;

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
      const [legRows, stayRows] = await Promise.all([
        db.query<{ stopId: string; seq: number; leg: Record<string, unknown>; fromHub: RawHub; toHub: RawHub }>(
          q("routes/legs"),
          { routeId },
          read,
        ),
        db.query<{
          stopId: string;
          status: string;
          rooms: unknown;
          arrive: string | null;
          depart: string | null;
          hotel: Record<string, unknown>;
          areaId: string;
          areaName: string;
        }>(q("routes/stays"), { routeId }, read),
      ]);
      const legsByStop = new Map<string, StoredLeg[]>();
      for (const row of legRows) {
        const l = row.leg;
        const list = legsByStop.get(row.stopId) ?? [];
        list.push({
          id: String(l.id),
          seq: num(row.seq),
          mode: (str(l.mode) ?? "flight") as LegMode,
          status: (str(l.status) ?? "idea") as LegStatus,
          operator: str(l.operator),
          number: str(l.number),
          departAt: str(l.departAt),
          arriveAt: str(l.arriveAt),
          durationMin: optNum(l.durationMin),
          priceCad: optNum(l.priceCad),
          source: str(l.source),
          asOf: str(l.asOf),
          bookingRef: str(l.bookingRef),
          seat: str(l.seat),
          from: toHub(row.fromHub),
          to: toHub(row.toHub),
        });
        legsByStop.set(row.stopId, list);
      }
      const staysByStop = new Map<string, StoredStay[]>();
      for (const row of stayRows) {
        const h = row.hotel;
        const list = staysByStop.get(row.stopId) ?? [];
        list.push({
          status: (str(row.status) ?? "shortlist") as StayStatus,
          rooms: optNum(row.rooms),
          arrive: str(row.arrive),
          depart: str(row.depart),
          hotel: {
            id: String(h.id),
            name: String(h.name),
            url: str(h.url),
            priceCadPerNight: optNum(h.priceCadPerNight),
            priceBasis: (str(h.priceBasis) ?? "room") as "room" | "person",
            sleeps: optNum(h.sleeps) ?? 2,
            areaId: row.areaId,
            areaName: row.areaName,
            lat: optNum(h.lat),
            lon: optNum(h.lon),
          },
        });
        staysByStop.set(row.stopId, list);
      }
      const statusRank: Record<string, number> = { booked: 0, chosen: 1, shortlist: 2 };
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
            stayCadPerNight: optNum(s.stop.stayCadPerNight),
            arriveCostCad: optNum(s.stop.arriveCostCad),
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
            legs: (legsByStop.get(String(s.stop.id)) ?? []).sort((a, b) => a.seq - b.seq),
            stays: (staysByStop.get(String(s.stop.id)) ?? []).sort(
              (a, b) =>
                (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3) || a.hotel.name.localeCompare(b.hotel.name),
            ),
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
        activity: { id: string; title: string; when: unknown; url: string | null; costCad: unknown; mapsQuery?: string | null };
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
          mapsQuery: r.activity.mapsQuery ?? null,
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
      const now = nowIso();
      const stopIds = source.stops.map(() => newId("st"));
      await db.query(q("routes/duplicate"), {
        fromRouteId: source.route.id,
        id,
        name,
        tags,
        now,
        stops: source.stops.map((s, i) => ({
          id: stopIds[i],
          order: i,
          cityCode: s.city.code,
          nights: s.nights,
          arriveMode: s.arriveMode,
          arriveNote: s.arriveNote,
          notes: s.notes,
          stayCadPerNight: s.stayCadPerNight,
          arriveCostCad: s.arriveCostCad,
          plans: s.planned.map((p) => ({ activityId: p.id, day: p.day ?? null })),
        })),
      });
      // Legs belong to one route's timeline, so they are copied with new ids; stays are re-linked.
      const legs = source.stops.flatMap((s, i) =>
        s.legs.map((l) => ({
          id: newId("lg"),
          stopId: stopIds[i],
          seq: l.seq,
          mode: l.mode,
          status: l.status,
          from: l.from.id,
          to: l.to.id,
          operator: l.operator ?? null,
          number: l.number ?? null,
          departAt: l.departAt ?? null,
          arriveAt: l.arriveAt ?? null,
          durationMin: l.durationMin ?? null,
          priceCad: l.priceCad ?? null,
          bookingRef: l.bookingRef,
          seat: l.seat,
          source: l.source ?? null,
          asOf: l.asOf ?? null,
          createdAt: now,
        })),
      );
      if (legs.length) await db.query(cypher("explorer/legs-create", db.dialect), { legs });
      const stays = source.stops.flatMap((s, i) =>
        s.stays.map((st) => ({
          stopId: stopIds[i],
          hotelId: st.hotel.id,
          status: st.status,
          rooms: st.rooms,
          arrive: st.arrive,
          depart: st.depart,
          at: now,
        })),
      );
      if (stays.length) await db.query(cypher("explorer/stays-create", db.dialect), { stays });
      return id;
    },

    // --- legs and stays: route-structure writes, guarded by the route version ---

    addLeg: (
      stopId: string,
      version: number,
      leg: {
        id: string;
        seq: number;
        mode: string;
        status: string;
        from: string;
        to: string;
        operator: string | null;
        number: string | null;
        departAt: string | null;
        arriveAt: string | null;
        durationMin: number | null;
        priceCad: number | null;
        bookingRef: string | null;
        seat: string | null;
      },
      arriveMode: string,
    ) => guarded("legs/add", { stopId, version, ...leg, arriveMode, now: nowIso(), today: nowIso().slice(0, 10) }),

    patchLeg: (legId: string, version: number, params: Record<string, unknown>) =>
      guarded("legs/patch", { legId, version, ...params }),

    async setLegHub(legId: string, end: "from" | "to", hubId: string) {
      await db.query(q(end === "from" ? "legs/set-from" : "legs/set-to"), { legId, hubId });
    },

    async reseqLegs(stopId: string, seqs: { legId: string; seq: number }[]) {
      if (seqs.length) await db.query(q("legs/reseq"), { stopId, seqs });
    },

    deleteLeg: (legId: string, version: number, arriveMode: string | null) =>
      guarded("legs/delete", { legId, version, arriveMode }),

    async legPrivate(legId: string) {
      const [row] = await db.query<{ id: string; bookingRef: string | null; seat: string | null }>(
        q("legs/private"),
        { legId },
        read,
      );
      return row ?? null;
    },

    setStay: (
      stopId: string,
      hotelId: string,
      version: number,
      stay: { status: string; rooms: number | null; arrive: string | null; depart: string | null },
    ) => guarded("stays/set", { stopId, hotelId, version, ...stay, now: nowIso() }),

    async demoteOtherStays(stopId: string, hotelId: string) {
      await db.query(q("stays/demote-others"), { stopId, hotelId });
    },

    deleteStay: (stopId: string, hotelId: string, version: number) => guarded("stays/delete", { stopId, hotelId, version }),

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
      input: {
        nights?: number;
        arriveMode?: string;
        arriveNote?: string;
        notes?: string;
        stayCadPerNight?: number | null;
        arriveCostCad?: number | null;
      },
    ) =>
      guarded("stops/patch", {
        stopId,
        version,
        nights: input.nights ?? null,
        arriveMode: input.arriveMode ?? null,
        arriveNote: input.arriveNote ?? null,
        notes: input.notes ?? null,
        setStay: input.stayCadPerNight !== undefined,
        stayCadPerNight: input.stayCadPerNight ?? null,
        setArriveCost: input.arriveCostCad !== undefined,
        arriveCostCad: input.arriveCostCad ?? null,
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
