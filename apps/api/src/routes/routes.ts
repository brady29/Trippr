import {
  addStopBody,
  patchRouteBody,
  patchStopBody,
  planBody,
  reorderBody,
  versionQuery,
  type Role,
  type RouteView,
  type StopLibrary,
} from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { badRequest, notFound, versionConflict } from "../errors";
import { newId } from "../ids";
import { routeToIcs, routeToText } from "../services/export";
import { buildRouteView } from "../services/route-view";

const idParams = z.object({ id: z.string().min(1) });
const planParams = z.object({ id: z.string().min(1), activityId: z.string().min(1) });

export function routeRoutes(app: FastifyInstance, ctx: AppContext) {
  const { repos, guards } = ctx;

  async function view(routeId: string, role: Role): Promise<RouteView> {
    const stored = await repos.routes.load(routeId);
    if (!stored) throw notFound("Route");
    return buildRouteView(stored, role);
  }

  async function loadOrThrow(routeId: string) {
    const stored = await repos.routes.load(routeId);
    if (!stored) throw notFound("Route");
    return stored;
  }

  /** A null version from a guarded write means someone else saved first. */
  async function afterWrite(routeId: string, newVersion: number | null, role: Role, who: { tripId: string; by: string }) {
    if (newVersion === null) {
      const current = await repos.routes.load(routeId);
      if (!current) throw notFound("Route");
      throw versionConflict(current.route.version);
    }
    ctx.notify(who.tripId, { kind: "route", routeId }, who.by);
    return view(routeId, role);
  }

  /** Stops, cities, planned activities, computed dates and checks. */
  app.get("/routes/:id", async (req) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role } = await guards.route(user, id, "viewer");
    return view(id, role);
  });

  /** Rename, tags, isCurrent. */
  app.patch("/routes/:id", async (req) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role, tripId } = await guards.route(user, id, "editor");
    const body = ctx.parse(patchRouteBody, req.body);
    const version = await repos.routes.patch(id, body.version, {
      name: body.name,
      tags: body.tags,
      makeCurrent: body.isCurrent === true,
    });
    return afterWrite(id, version, role, { tripId, by: user.id });
  });

  app.delete("/routes/:id", async (req, reply) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { tripId } = await guards.route(user, id, "owner");
    await repos.routes.delete(id);
    ctx.notify(tripId, { kind: "trip" }, user.id);
    reply.status(204);
  });

  /** Query 2: each stop's shared city library, with planned flags and votes. */
  app.get("/routes/:id/library", async (req): Promise<StopLibrary[]> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.route(user, id, "viewer");
    const [stored, byStop] = await Promise.all([loadOrThrow(id), repos.routes.library(id, user.id)]);
    return stored.stops.map((s) => ({
      stopId: s.id,
      cityCode: s.city.code,
      activities: byStop.get(s.id)?.activities ?? [],
    }));
  });

  /** Add a stop { cityCode, nights, position }. */
  app.post("/routes/:id/stops", async (req, reply) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role, tripId } = await guards.route(user, id, "editor");
    const body = ctx.parse(addStopBody, req.body);
    const [stored, city] = await Promise.all([loadOrThrow(id), repos.cities.get(body.cityCode)]);
    if (!city) throw notFound(`City ${body.cityCode}`);
    if (stored.route.version !== body.version) throw versionConflict(stored.route.version);
    const position = Math.min(body.position ?? stored.stops.length, stored.stops.length);
    const stopId = newId("st");
    const ids = stored.stops.map((s) => s.id);
    ids.splice(position, 0, stopId);
    const version = await repos.routes.addStop(
      id,
      body.version,
      { id: stopId, cityCode: body.cityCode, nights: body.nights, arriveMode: body.arriveMode, order: position },
      ids.map((sid, order) => ({ id: sid, order })),
    );
    reply.status(201);
    return afterWrite(id, version, role, { tripId, by: user.id });
  });

  /** Reorder: { stopIds: [...], version }. */
  app.put("/routes/:id/order", async (req) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role, tripId } = await guards.route(user, id, "editor");
    const body = ctx.parse(reorderBody, req.body);
    const stored = await loadOrThrow(id);
    if (stored.route.version !== body.version) throw versionConflict(stored.route.version);
    const current = new Set(stored.stops.map((s) => s.id));
    const given = new Set(body.stopIds);
    if (given.size !== body.stopIds.length || given.size !== current.size || ![...given].every((s) => current.has(s))) {
      throw badRequest("stopIds must list every stop in the route exactly once");
    }
    const version = await repos.routes.reorder(
      id,
      body.version,
      body.stopIds.map((sid, order) => ({ id: sid, order })),
    );
    return afterWrite(id, version, role, { tripId, by: user.id });
  });

  /** Nights, travel mode, travel note, notes. */
  app.patch("/stops/:id", async (req) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role, routeId, tripId } = await guards.stop(user, id, "editor");
    const body = ctx.parse(patchStopBody, req.body);
    const version = await repos.routes.patchStop(id, body.version, body);
    return afterWrite(routeId, version, role, { tripId, by: user.id });
  });

  app.delete("/stops/:id", async (req) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role, routeId, tripId } = await guards.stop(user, id, "editor");
    const { version } = ctx.parse(versionQuery, req.query);
    return afterWrite(routeId, await repos.routes.deleteStop(id, version), role, { tripId, by: user.id });
  });

  /** Plan an activity at a stop. Idempotent, so it needs no version. */
  app.put("/stops/:id/plans/:activityId", async (req) => {
    const user = ctx.user(req);
    const { id, activityId } = ctx.parse(planParams, req.params);
    const { role, routeId, tripId } = await guards.stop(user, id, "editor");
    const activity = await guards.activity(user, activityId, "viewer");
    if (activity.tripId !== tripId) throw notFound("Activity");
    const { day } = ctx.parse(planBody, req.body);
    if (!(await repos.routes.plan(id, activityId, day ?? null))) {
      throw badRequest("That activity is in a different city from this stop");
    }
    ctx.notify(tripId, { kind: "route", routeId }, user.id);
    return view(routeId, role);
  });

  app.delete("/stops/:id/plans/:activityId", async (req) => {
    const user = ctx.user(req);
    const { id, activityId } = ctx.parse(planParams, req.params);
    const { role, routeId, tripId } = await guards.stop(user, id, "editor");
    await repos.routes.unplan(id, activityId);
    ctx.notify(tripId, { kind: "route", routeId }, user.id);
    return view(routeId, role);
  });

  // --- export (stretch) --------------------------------------------------------

  const filename = (v: RouteView, ext: string) =>
    `${`${v.trip.name}-${v.route.name}`.replace(/[^\w-]+/g, "-").toLowerCase()}.${ext}`;

  app.get("/routes/:id/export.txt", async (req, reply) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role } = await guards.route(user, id, "viewer");
    const v = await view(id, role);
    reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("content-disposition", `attachment; filename="${filename(v, "txt")}"`);
    return routeToText(v);
  });

  app.get("/routes/:id/export.ics", async (req, reply) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role } = await guards.route(user, id, "viewer");
    const v = await view(id, role);
    reply
      .header("content-type", "text/calendar; charset=utf-8")
      .header("content-disposition", `attachment; filename="${filename(v, "ics")}"`);
    return routeToIcs(v);
  });
}
