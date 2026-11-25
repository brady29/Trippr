import type { Area, AreaVibe, Hotel, Hub, HubKind, PriceBasis, Role, StayStatus } from "@trippr/contracts";
import type { GraphClient } from "../db/graph";
import { newId, nowIso } from "../ids";
import { cypher } from "./queries";
import { toHub } from "./routes";
import { num, optNum, str } from "./util";

type RoleRow = { tripId: string; routeId?: string; stopId?: string; role: Role | null };

/** Nullable fields: absent leaves them alone, null clears them (set-flag pattern). */
function setFlags<T extends Record<string, unknown>>(input: T, fields: Record<string, keyof T>) {
  const out: Record<string, unknown> = {};
  for (const [flag, key] of Object.entries(fields)) {
    out[flag] = input[key] !== undefined;
    out[key as string] = input[key] ?? null;
  }
  return out;
}

const sign = (n: unknown) => Math.sign(num(n)) as -1 | 0 | 1;

/** How far an Area reaches from its centre unless someone edits it (docs/data-platform-spec.md, Feature 5). */
export const DEFAULT_AREA_RADIUS_KM = 1.5;

/** Stations, airports, areas to stay and hotels. Legs and stays live with routes. */
export function explorerRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const read = { readOnly: true };
  const one = async (name: string, params: Record<string, unknown>) =>
    (await db.query<RoleRow>(q(name), params, read))[0] ?? null;

  async function listAreas(tripId: string, userId: string, filter: { city?: string; areaId?: string } = {}): Promise<Area[]> {
    const rows = await db.query<{
      area: Record<string, unknown>;
      cityCode: string;
      cityName: string;
      votes: number;
      myVote: number;
      hotelCount: number;
    }>(q("areas/list"), { tripId, userId, city: filter.city ?? null, areaId: filter.areaId ?? null }, read);
    return rows.map((r) => ({
      id: String(r.area.id),
      name: String(r.area.name),
      lat: optNum(r.area.lat),
      lon: optNum(r.area.lon),
      vibes: (Array.isArray(r.area.vibes) ? r.area.vibes : []) as AreaVibe[],
      note: str(r.area.note),
      radiusKm: optNum(r.area.radiusKm) ?? DEFAULT_AREA_RADIUS_KM,
      cityCode: r.cityCode,
      cityName: r.cityName,
      votes: num(r.votes),
      myVote: sign(r.myVote),
      hotelCount: num(r.hotelCount),
    }));
  }

  async function listHotels(tripId: string, userId: string, filter: { city?: string; hotelId?: string } = {}): Promise<Hotel[]> {
    const rows = await db.query<{
      hotel: Record<string, unknown>;
      areaId: string;
      areaName: string;
      cityCode: string;
      cityName: string;
      votes: number;
      myVote: number;
      stays: { stopId: string | null; routeId: string | null; routeName: string | null; status: string | null }[];
    }>(q("hotels/list"), { tripId, userId, city: filter.city ?? null, hotelId: filter.hotelId ?? null }, read);
    return rows.map((r) => ({
      id: String(r.hotel.id),
      name: String(r.hotel.name),
      url: str(r.hotel.url),
      lat: optNum(r.hotel.lat),
      lon: optNum(r.hotel.lon),
      priceCadPerNight: optNum(r.hotel.priceCadPerNight),
      priceBasis: (str(r.hotel.priceBasis) ?? "room") as PriceBasis,
      sleeps: optNum(r.hotel.sleeps) ?? 2,
      rating: optNum(r.hotel.rating),
      notes: str(r.hotel.notes),
      areaId: r.areaId,
      areaName: r.areaName,
      cityCode: r.cityCode,
      cityName: r.cityName,
      votes: num(r.votes),
      myVote: sign(r.myVote),
      // FalkorDB and Neo4j differ on maps of nulls from OPTIONAL MATCH; drop the empty ones.
      stays: (r.stays ?? [])
        .filter((s) => s && s.stopId != null)
        .map((s) => ({
          stopId: String(s.stopId),
          routeId: String(s.routeId),
          routeName: String(s.routeName),
          status: (s.status ?? "shortlist") as StayStatus,
        })),
    }));
  }

  return {
    legRole: (legId: string, userId: string) => one("access/leg-role", { legId, userId }),
    areaRole: (areaId: string, userId: string) => one("access/area-role", { areaId, userId }),
    hotelRole: (hotelId: string, userId: string) => one("access/hotel-role", { hotelId, userId }),

    async searchHubs(filter: { q: string; city?: string; kind?: HubKind; limit: number }): Promise<Hub[]> {
      const rows = await db.query<{ hub: Record<string, unknown> }>(
        q("hubs/search"),
        { q: filter.q, city: filter.city ?? null, kind: filter.kind ?? null, limit: filter.limit },
        read,
      );
      return rows.map((r) => toHub(r.hub));
    },

    async getHubs(ids: string[]): Promise<Map<string, Hub>> {
      const rows = await db.query<{ hub: Record<string, unknown> }>(q("hubs/get-many"), { ids }, read);
      return new Map(rows.map((r) => [String(r.hub.hubId), toHub(r.hub)]));
    },

    listAreas,
    getArea: async (tripId: string, userId: string, areaId: string) => (await listAreas(tripId, userId, { areaId }))[0] ?? null,

    async createArea(
      userId: string,
      input: { tripId: string; cityCode: string; name: string; vibes: string[]; lat?: number | null; lon?: number | null; note?: string | null; radiusKm?: number | null },
    ) {
      const id = newId("area");
      await db.query(q("areas/create"), {
        id,
        userId,
        tripId: input.tripId,
        cityCode: input.cityCode,
        name: input.name,
        vibes: input.vibes,
        lat: input.lat ?? null,
        lon: input.lon ?? null,
        note: input.note ?? null,
        radiusKm: input.radiusKm ?? DEFAULT_AREA_RADIUS_KM,
        now: nowIso(),
      });
      return id;
    },

    async patchArea(
      areaId: string,
      input: { name?: string; vibes?: string[]; lat?: number | null; lon?: number | null; note?: string | null; radiusKm?: number | null },
    ) {
      await db.query(q("areas/patch"), {
        areaId,
        name: input.name ?? null,
        vibes: input.vibes ?? null,
        ...setFlags(input, { setLat: "lat", setLon: "lon", setNote: "note", setRadiusKm: "radiusKm" }),
      });
    },

    async deleteArea(areaId: string) {
      // Open-data hotel suggestions hang off the Area and go with it; the group's own hotels block the delete earlier.
      await db.query(q("hotels/delete-catalogue-in-area"), { areaId });
      await db.query(q("areas/delete"), { areaId });
    },

    async voteArea(userId: string, areaId: string, value: -1 | 0 | 1) {
      if (value === 0) await db.query(q("areas/unvote"), { userId, areaId });
      else await db.query(q("areas/vote"), { userId, areaId, value, now: nowIso() });
    },

    listHotels,
    getHotel: async (tripId: string, userId: string, hotelId: string) =>
      (await listHotels(tripId, userId, { hotelId }))[0] ?? null,

    async createHotel(
      userId: string,
      input: {
        tripId: string;
        areaId: string;
        name: string;
        url?: string | null;
        lat?: number | null;
        lon?: number | null;
        priceCadPerNight?: number | null;
        priceBasis: PriceBasis;
        sleeps: number;
        rating?: number | null;
        notes?: string | null;
      },
    ) {
      const id = newId("hotel");
      await db.query(q("hotels/create"), {
        id,
        userId,
        tripId: input.tripId,
        areaId: input.areaId,
        name: input.name,
        url: input.url ?? null,
        lat: input.lat ?? null,
        lon: input.lon ?? null,
        priceCadPerNight: input.priceCadPerNight ?? null,
        priceBasis: input.priceBasis,
        sleeps: input.sleeps,
        rating: input.rating ?? null,
        notes: input.notes ?? null,
        now: nowIso(),
      });
      return id;
    },

    async patchHotel(
      hotelId: string,
      input: {
        name?: string;
        priceBasis?: PriceBasis;
        sleeps?: number;
        url?: string | null;
        lat?: number | null;
        lon?: number | null;
        priceCadPerNight?: number | null;
        rating?: number | null;
        notes?: string | null;
      },
    ) {
      await db.query(q("hotels/patch"), {
        hotelId,
        name: input.name ?? null,
        priceBasis: input.priceBasis ?? null,
        sleeps: input.sleeps ?? null,
        ...setFlags(input, {
          setUrl: "url",
          setLat: "lat",
          setLon: "lon",
          setPrice: "priceCadPerNight",
          setRating: "rating",
          setNotes: "notes",
        }),
      });
    },

    async moveHotel(hotelId: string, areaId: string) {
      await db.query(q("hotels/move"), { hotelId, areaId });
    },

    async deleteHotel(hotelId: string) {
      await db.query(q("hotels/delete"), { hotelId });
    },

    async voteHotel(userId: string, hotelId: string, value: -1 | 0 | 1) {
      if (value === 0) await db.query(q("hotels/unvote"), { userId, hotelId });
      else await db.query(q("hotels/vote"), { userId, hotelId, value, now: nowIso() });
    },
  };
}
