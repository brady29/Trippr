import {
  compareQuery,
  createInviteBody,
  createRouteBody,
  createTripBody,
  hasRole,
  patchTripBody,
  roleSchema,
  type CompareResult,
  type Invite,
  type InvitePreview,
  type RouteView,
  type TripDetail,
} from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { badRequest, inviteExpired, notFound } from "../errors";
import { newToken } from "../ids";
import { buildRouteView, summarize } from "../services/route-view";

const idParams = z.object({ id: z.string().min(1) });

export function tripRoutes(app: FastifyInstance, ctx: AppContext) {
  const { repos, guards, config } = ctx;

  async function routeView(routeId: string, role: Parameters<typeof buildRouteView>[1]): Promise<RouteView> {
    const stored = await repos.routes.load(routeId);
    if (!stored) throw notFound("Route");
    return buildRouteView(stored, role);
  }

  app.get("/trips", async (req) => repos.trips.listForUser(ctx.user(req).id));

  app.post("/trips", async (req, reply) => {
    const user = ctx.user(req);
    const body = ctx.parse(createTripBody, req.body);
    const id = await repos.trips.create(user.id, body);
    reply.status(201);
    return { id };
  });

  /** Trip, members and routes with summary stats (and a checks level for the badge). */
  app.get("/trips/:id", async (req): Promise<TripDetail> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role } = await guards.trip(user, id, "viewer");
    const [trip, members, routeIds] = await Promise.all([
      repos.trips.get(id),
      repos.trips.members(id),
      repos.trips.routeIds(id),
    ]);
    if (!trip) throw notFound("Trip");
    const routes = await Promise.all(routeIds.map(async (rid) => summarize(await routeView(rid, role))));
    routes.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.createdAt.localeCompare(b.createdAt));
    return { trip, role, members, routes };
  });

  app.patch("/trips/:id", async (req) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "owner");
    await repos.trips.patch(id, ctx.parse(patchTripBody, req.body));
    return repos.trips.get(id);
  });

  /** Owner changes a member's role. */
  app.put("/trips/:id/members/:userId", async (req) => {
    const user = ctx.user(req);
    const { id, userId } = ctx.parse(idParams.extend({ userId: z.string().min(1) }), req.params);
    await guards.trip(user, id, "owner");
    const { role } = ctx.parse(z.object({ role: roleSchema }), req.body);
    if (userId === user.id && role !== "owner") throw badRequest("Owners cannot demote themselves");
    const member = await repos.access.tripRole(id, userId);
    if (!member?.role) throw notFound("Member");
    await repos.trips.setMemberRole(id, userId, role);
    return repos.trips.members(id);
  });

  /**
   * The owner removes a member, or any member leaves (their own id).
   * A trip always keeps at least one owner.
   */
  app.delete("/trips/:id/members/:userId", async (req) => {
    const user = ctx.user(req);
    const { id, userId } = ctx.parse(idParams.extend({ userId: z.string().min(1) }), req.params);
    const leaving = userId === user.id;
    await guards.trip(user, id, leaving ? "viewer" : "owner");
    const members = await repos.trips.members(id);
    const target = members.find((m) => m.id === userId);
    if (!target) throw notFound("Member");
    if (target.role === "owner" && members.filter((m) => m.role === "owner").length === 1) {
      throw badRequest("A trip needs an owner. Make someone else an owner first.");
    }
    await repos.trips.removeMember(id, userId);
    return leaving ? [] : repos.trips.members(id);
  });

  // --- invites ---------------------------------------------------------------

  app.post("/trips/:id/invites", async (req, reply): Promise<Invite> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "owner");
    const body = ctx.parse(createInviteBody, req.body);
    const token = newToken();
    const expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString();
    await repos.trips.createInvite(id, user.id, body.role, token, expiresAt);
    reply.status(201);
    return { token, role: body.role, expiresAt, url: `${config.PUBLIC_WEB_URL}/invite/${token}` };
  });

  /** Public preview so the invite page can show the trip name before sign-in. */
  app.get("/invites/:token", async (req): Promise<InvitePreview> => {
    const { token } = ctx.parse(z.object({ token: z.string().min(8) }), req.params);
    const invite = await repos.trips.getInvite(token);
    if (!invite) throw notFound("Invite");
    return { ...invite, expired: invite.expiresAt < new Date().toISOString() };
  });

  app.post("/invites/:token/accept", async (req) => {
    const user = ctx.user(req);
    const { token } = ctx.parse(z.object({ token: z.string().min(8) }), req.params);
    const invite = await repos.trips.getInvite(token);
    if (!invite) throw notFound("Invite");
    if (invite.expiresAt < new Date().toISOString()) throw inviteExpired();
    const current = await repos.access.tripRole(invite.trip.id, user.id);
    // Accepting never downgrades someone who already has a higher role.
    if (!hasRole(current?.role, invite.role)) await repos.trips.setMemberRole(invite.trip.id, user.id, invite.role);
    // Owner invites are single-use; group invites stay valid until they expire.
    if (invite.role === "owner") await repos.trips.deleteInvite(token);
    const role = hasRole(current?.role, invite.role) ? current!.role! : invite.role;
    return { tripId: invite.trip.id, role };
  });

  // --- routes in a trip --------------------------------------------------------

  /** New empty route, or a duplicate of { fromRouteId }. */
  app.post("/trips/:id/routes", async (req, reply): Promise<RouteView> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role } = await guards.trip(user, id, "editor");
    const body = ctx.parse(createRouteBody, req.body);
    let routeId: string;
    if (body.fromRouteId) {
      const source = await repos.routes.load(body.fromRouteId);
      if (!source || source.trip.id !== id) throw notFound("Source route");
      const tags = body.tags ?? source.route.tags.filter((t) => t !== "current");
      routeId = await repos.routes.duplicate(source, body.name ?? `${source.route.name} copy`, tags);
    } else {
      routeId = await repos.routes.create(id, body.name ?? "New route", body.tags ?? []);
    }
    reply.status(201);
    return routeView(routeId, role);
  });

  /** Two routes side by side: shared and unique cities, nights per country, activities gained or lost. */
  app.get("/compare", async (req): Promise<CompareResult> => {
    const user = ctx.user(req);
    const { a, b } = ctx.parse(compareQuery, req.query);
    const [ga, gb] = await Promise.all([guards.route(user, a, "viewer"), guards.route(user, b, "viewer")]);
    const [viewA, viewB, cities, nightsA, nightsB] = await Promise.all([
      routeView(a, ga.role),
      routeView(b, gb.role),
      repos.routes.compareCities(a, b),
      repos.routes.nightsByCountry(a),
      repos.routes.nightsByCountry(b),
    ]);
    const countries = new Map<string, { country: string; iso: string; a: number; b: number }>();
    for (const n of nightsA) countries.set(n.iso, { country: n.country, iso: n.iso, a: n.nights, b: 0 });
    for (const n of nightsB) {
      const entry = countries.get(n.iso) ?? { country: n.country, iso: n.iso, a: 0, b: 0 };
      entry.b = n.nights;
      countries.set(n.iso, entry);
    }
    const planned = (view: RouteView) => {
      const map = new Map<string, RouteView["stops"][number]["planned"][number]>();
      for (const s of view.stops) for (const p of s.planned) map.set(p.id, p);
      return map;
    };
    const pa = planned(viewA);
    const pb = planned(viewB);
    return {
      a: summarize(viewA),
      b: summarize(viewB),
      ...cities,
      nightsByCountry: [...countries.values()].sort((x, y) => y.a + y.b - (x.a + x.b)),
      activitiesGained: [...pb.values()].filter((p) => !pa.has(p.id)),
      activitiesLost: [...pa.values()].filter((p) => !pb.has(p.id)),
    };
  });
}
