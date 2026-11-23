import type { GraphClient } from "../db/graph";
import { nowIso } from "../ids";
import { cypher } from "./queries";
import { optNum, str } from "./util";

/** One stored snapshot: the lowest price for a route's planned date as of one day, plus the days around it. */
export interface FlightSnapshotRow {
  snapshotDate: string;
  priceCad: number | null;
  airline: string | null;
  stops: number | null;
  /** The days searched around the planned date. */
  window: { date: string; priceCad: number | null; airline: string | null; stops: number | null }[];
  prevLowCad: number | null;
  dropPct: number | null;
}

export interface FlightSnapshotWrite {
  provider: string;
  origin: string;
  destination: string;
  departDate: string;
  snapshotDate: string;
  priceCad: number | null;
  airline: string | null;
  stops: number | null;
  window: FlightSnapshotRow["window"];
  sample: boolean;
  prevLowCad: number | null;
  dropPct: number | null;
}

/** One snapshot series per provider, origin, destination and departure date. */
export const flightRouteKey = (provider: string, origin: string, destination: string, departDate: string) =>
  `${provider}:${origin}-${destination}-${departDate}`;

export const flightSnapshotId = (routeKey: string, snapshotDate: string) => `${routeKey}:${snapshotDate}`;

const MAX_HISTORY = 500;

/** Daily flight price snapshots, kept as a small time series in the graph (one node per route and day). */
export function flightsRepository(db: GraphClient) {
  const q = (name: string) => cypher(`flights/${name}`, db.dialect);
  const read = { readOnly: true };

  return {
    /** Every trip's routes; the caller picks each trip's current one. */
    async listRoutes(): Promise<{ tripId: string; routeId: string; isCurrent: boolean }[]> {
      const rows = await db.query<{ tripId: string; routeId: string; isCurrent: unknown }>(q("routes"), {}, read);
      return rows.map((r) => ({ tripId: String(r.tripId), routeId: String(r.routeId), isCurrent: r.isCurrent === true }));
    },

    async hasSnapshot(routeKey: string, snapshotDate: string): Promise<boolean> {
      const rows = await db.query(q("exists"), { id: flightSnapshotId(routeKey, snapshotDate) }, read);
      return rows.length > 0;
    },

    async saveSnapshot(s: FlightSnapshotWrite): Promise<void> {
      const routeKey = flightRouteKey(s.provider, s.origin, s.destination, s.departDate);
      await db.query(q("upsert"), {
        id: flightSnapshotId(routeKey, s.snapshotDate),
        routeKey,
        provider: s.provider,
        origin: s.origin,
        destination: s.destination,
        departDate: s.departDate,
        snapshotDate: s.snapshotDate,
        priceCad: s.priceCad,
        airline: s.airline,
        stops: s.stops,
        windowJson: JSON.stringify(s.window),
        sample: s.sample,
        prevLowCad: s.prevLowCad,
        dropPct: s.dropPct,
        fetchedAt: nowIso(),
      });
    },

    /** Snapshots for one route, oldest first. */
    async history(routeKey: string): Promise<FlightSnapshotRow[]> {
      const rows = await db.query<Record<string, unknown>>(q("history"), { routeKey, limit: MAX_HISTORY }, read);
      return rows.map((r) => {
        let window: FlightSnapshotRow["window"] = [];
        try {
          const parsed = JSON.parse(String(r.windowJson ?? "[]")) as unknown;
          if (Array.isArray(parsed)) window = parsed as FlightSnapshotRow["window"];
        } catch {
          /* a damaged window is only a missing extra */
        }
        return {
          snapshotDate: String(r.snapshotDate),
          priceCad: optNum(r.priceCad),
          airline: str(r.airline),
          stops: optNum(r.stops),
          window,
          prevLowCad: optNum(r.prevLowCad),
          dropPct: optNum(r.dropPct),
        };
      });
    },

    async requestsToday(runId: string): Promise<number> {
      const [row] = await db.query<{ requests: unknown }>(q("run-get"), { id: runId }, read);
      return row ? (optNum(row.requests) ?? 0) : 0;
    },

    async addRequests(runId: string, provider: string, day: string, n: number): Promise<void> {
      if (n > 0) await db.query(q("run-add"), { id: runId, provider, day, n, now: nowIso() });
    },

    /** Returns true when the leg was updated (it is an idea and its price is not a person's). */
    async setLegPrice(legId: string, priceCad: number, asOf: string, source: string): Promise<boolean> {
      const rows = await db.query(q("leg-price"), { legId, priceCad, asOf, source });
      return rows.length > 0;
    },
  };
}
