import { travelOptionsQuery, type TravelOptionsResult } from "@trippr/contracts";
import { distanceKm, travelOptions, type KnownLink, type PlaceFacts } from "@trippr/rules";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { badRequest, notFound } from "../errors";
import { cypher } from "../repositories/queries";

type FactsRow = {
  code: string;
  name: string;
  lat: number;
  lon: number;
  countryIso: string;
  hubs: { kind: string | null; stationKind: string | null }[];
};

export function travelRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const read = { readOnly: true };

  /**
   * Recommended ways between two places: stored links first, then estimates
   * for flying, high-speed rail, trains, buses and a rental car, ranked by
   * the chosen priority.
   */
  app.get("/travel-options", async (req): Promise<TravelOptionsResult> => {
    ctx.user(req);
    const q = ctx.parse(travelOptionsQuery, req.query);
    if (q.from === q.to) throw badRequest("Pick two different places");
    const rows = await db.query<FactsRow>(cypher("travel/facts", db.dialect), { codes: [q.from, q.to] }, read);
    const facts = (code: string): PlaceFacts => {
      const r = rows.find((x) => x.code === code);
      if (!r) throw notFound(`City ${code}`);
      const hubs = (r.hubs ?? []).filter((h) => h && h.kind);
      return {
        code: r.code,
        name: r.name,
        countryIso: r.countryIso,
        lat: Number(r.lat),
        lon: Number(r.lon),
        airport: hubs.some((h) => h.kind === "airport"),
        hsr: hubs.some((h) => h.kind === "station" && h.stationKind === "hsr"),
        rail: hubs.some((h) => h.kind === "station" && h.stationKind !== "maglev" && h.stationKind !== "metro"),
      };
    };
    const from = facts(q.from);
    const to = facts(q.to);
    const links = await db.query<KnownLink>(cypher("travel/links", db.dialect), { from: q.from, to: q.to }, read);
    // An undirected match returns both directions; keep one link per mode.
    const byMode = new Map(links.map((l) => [l.mode, l]));
    return {
      from: { code: from.code, name: from.name },
      to: { code: to.code, name: to.name },
      distanceKm: Math.round(distanceKm(from, to)),
      priority: q.priority,
      travellers: q.travellers,
      options: travelOptions(from, to, [...byMode.values()], { travellers: q.travellers, priority: q.priority }),
    };
  });
}
