import { citySearchQuery, pathQuery, type Health, type PathResult } from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { badRequest, notFound } from "../errors";

export function metaRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, repos } = ctx;

  /** Uptime check: runs one trivial query. */
  app.get("/health", async (_req, reply): Promise<Health> => {
    const ok = await db.ping().catch(() => false);
    reply.status(ok ? 200 : 503);
    return { ok, db: ok ? "up" : "down", dialect: db.dialect };
  });

  /** City search for the add-stop box. */
  app.get("/cities", async (req) => {
    ctx.user(req);
    const { q, limit } = ctx.parse(citySearchQuery, req.query);
    return repos.cities.search(q, limit);
  });

  /** Pathfinding over stored train and flight links (stretch). */
  app.get("/paths", async (req): Promise<PathResult> => {
    ctx.user(req);
    const query = ctx.parse(pathQuery, req.query);
    if (query.from === query.to) throw badRequest("Pick two different cities");
    const [from, to] = await Promise.all([repos.cities.get(query.from), repos.cities.get(query.to)]);
    if (!from) throw notFound(`City ${query.from}`);
    if (!to) throw notFound(`City ${query.to}`);
    const { codes, ...result } = await repos.cities.path(query.from, query.to, query.by, query.railOnly);
    const cities = await repos.cities.getMany(codes);
    return { ...result, cities: codes.map((c) => cities.get(c)).filter((c) => c !== undefined) };
  });
}
