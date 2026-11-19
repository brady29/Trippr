import type { Hub } from "@trippr/contracts";
import type { GraphClient } from "../db/graph";
import { cypher } from "./queries";
import { toHub } from "./routes";
import { num, optNum, str } from "./util";

export interface GraphRouteRow {
  id: string;
  name: string;
  isCurrent: boolean;
  version: number;
  createdAt: string;
}

export interface SkeletonRow {
  routeId: string;
  routeName: string;
  stop: { id: string; order: number; nights: number; arriveMode: string | null };
  city: { code: string; name: string; lat: number; lon: number };
  country: { iso: string; name: string; color: string | null };
}

export interface GraphLegRow {
  routeId: string;
  stopId: string;
  cityCode: string;
  seq: number;
  leg: {
    id: string;
    mode: string;
    operator: string | null;
    number: string | null;
    departAt: string | null;
    arriveAt: string | null;
    durationMin: number | null;
    priceCad: number | null;
    status: string;
  };
  from: Hub;
  to: Hub;
}

/** The graph export's own reads (G0, G1, G4); activities, areas and hotels reuse the library queries. */
export function graphRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const read = { readOnly: true };
  return {
    async trip(tripId: string) {
      const [row] = await db.query<{
        trip: { id: string; name: string; startDate: string } | null;
        routes: Record<string, unknown>[];
      }>(q("graph/routes"), { tripId }, read);
      if (!row?.trip?.id) return null;
      const routes: GraphRouteRow[] = (row.routes ?? [])
        .filter((r) => r && r.id != null)
        .map((r) => ({
          id: String(r.id),
          name: String(r.name),
          isCurrent: Boolean(r.isCurrent),
          version: num(r.version),
          createdAt: String(r.createdAt ?? ""),
        }))
        .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.createdAt.localeCompare(b.createdAt));
      return { trip: row.trip, routes };
    },

    async skeleton(tripId: string, routeId: string | null, city: string | null): Promise<SkeletonRow[]> {
      const rows = await db.query<{
        routeId: string;
        routeName: string;
        stop: Record<string, unknown>;
        city: Record<string, unknown>;
        country: Record<string, unknown>;
      }>(q("graph/skeleton"), { tripId, routeId, city }, read);
      return rows.map((r) => ({
        routeId: r.routeId,
        routeName: r.routeName,
        stop: { id: String(r.stop.id), order: num(r.stop.order), nights: num(r.stop.nights), arriveMode: str(r.stop.arriveMode) },
        city: { code: String(r.city.code), name: String(r.city.name), lat: num(r.city.lat), lon: num(r.city.lon) },
        country: { iso: String(r.country.iso), name: String(r.country.name), color: str(r.country.color) },
      }));
    },

    async legs(tripId: string, routeId: string | null): Promise<GraphLegRow[]> {
      const rows = await db.query<{
        routeId: string;
        stopId: string;
        cityCode: string;
        seq: number;
        leg: Record<string, unknown>;
        fromHub: Record<string, unknown>;
        toHub: Record<string, unknown>;
      }>(q("graph/legs"), { tripId, routeId }, read);
      return rows.map((r) => ({
        routeId: r.routeId,
        stopId: r.stopId,
        cityCode: r.cityCode,
        seq: num(r.seq),
        leg: {
          id: String(r.leg.id),
          mode: String(r.leg.mode),
          operator: str(r.leg.operator),
          number: str(r.leg.number),
          departAt: str(r.leg.departAt),
          arriveAt: str(r.leg.arriveAt),
          durationMin: optNum(r.leg.durationMin),
          priceCad: optNum(r.leg.priceCad),
          status: str(r.leg.status) ?? "idea",
        },
        from: toHub(r.fromHub),
        to: toHub(r.toHub),
      }));
    },
  };
}
