import {
  cityCode,
  createAreaBody,
  createHotelBody,
  createLegBody,
  graphQuery,
  hubSearchQuery,
  patchAreaBody,
  patchHotelBody,
  patchLegBody,
  stayBody,
  tripQuery,
  versionQuery,
  voteBody,
  type Area,
  type GraphJSON,
  type Hotel,
  type Hub,
  type HubRef,
  type LegPrivate,
  type Role,
  type RouteView,
} from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { badRequest, notFound, versionConflict } from "../errors";
import { newId } from "../ids";
import { arriveModeFor } from "../repositories/routes";
import { buildGraph, graphEtag, neighbourhood } from "../services/graph";
import { buildRouteView } from "../services/route-view";

const idParams = z.object({ id: z.string().min(1) });
const stayParams = z.object({ id: z.string().min(1), hotelId: z.string().min(1) });

export function explorerRoutes(app: FastifyInstance, ctx: AppContext) {
  const { repos, guards } = ctx;

  async function loadOrThrow(routeId: string) {
    const stored = await repos.routes.load(routeId);
    if (!stored) throw notFound("Route");
    return stored;
  }

  /** Same contract as the other route-structure writes: 409 on a stale version, the full route on success. */
  async function afterWrite(routeId: string, newVersion: number | null, role: Role, who: { tripId: string; by: string }) {
    if (newVersion === null) throw versionConflict((await loadOrThrow(routeId)).route.version);
    ctx.notify(who.tripId, { kind: "route", routeId }, who.by);
    return buildRouteView(await loadOrThrow(routeId), role);
  }

  async function requireHubs(refs: HubRef[]): Promise<Map<string, Hub>> {
    const hubs = await repos.explorer.getHubs(refs.map((r) => r.id));
    for (const r of refs) {
      const hub = hubs.get(r.id);
      if (!hub || hub.kind !== r.kind) throw badRequest(`Unknown ${r.kind} "${r.id}"`);
    }
    return hubs;
  }

  // --- graph ------------------------------------------------------------------

  /** GraphJSON for the trip, one route or one city, with an ETag so refetches are cheap. */
  app.get("/trips/:id/graph", async (req, reply) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "viewer");
    const query = ctx.parse(graphQuery, req.query);
    if (query.scope === "city" && !query.city) throw badRequest("A city scope needs ?city=");
    if (query.routeId) {
      const route = await guards.route(user, query.routeId, "viewer");
      if (route.tripId !== id) throw notFound("Route");
    }
    const graph = await buildGraph(repos, {
      tripId: id,
      userId: user.id,
      scope: query.scope,
      routeId: query.routeId ?? null,
      city: query.city ?? null,
      types: query.types,
    });
    if (!graph) throw notFound("Trip");
    const etag = graphEtag(graph);
    reply.header("etag", etag).header("cache-control", "private, max-age=0, must-revalidate");
    // Fastify only sends an empty async response for 204, so a 304 is sent explicitly.
    if (req.headers["if-none-match"] === etag) return reply.status(304).send();
    return graph satisfies GraphJSON;
  });

  /** Expand one node: its one-hop neighbourhood in the trip graph (G5). */
  app.get("/trips/:id/graph/nodes/:nodeId/neighbours", async (req): Promise<GraphJSON> => {
    const user = ctx.user(req);
    const { id, nodeId } = ctx.parse(z.object({ id: z.string().min(1), nodeId: z.string().min(1).max(120) }), req.params);
    await guards.trip(user, id, "viewer");
    const { limit } = ctx.parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const graph = await buildGraph(repos, { tripId: id, userId: user.id, scope: "trip" });
    if (!graph) throw notFound("Trip");
    const near = neighbourhood(graph, nodeId, limit);
    if (!near) throw notFound("Node");
    return near;
  });

  // --- hubs -------------------------------------------------------------------

  /** Station and airport search for the leg form. */
  app.get("/hubs", async (req): Promise<Hub[]> => {
    ctx.user(req);
    const query = ctx.parse(hubSearchQuery, req.query);
    return repos.explorer.searchHubs(query);
  });

  // --- legs (route-structure writes) ---------------------------------------------

  app.post("/stops/:id/legs", async (req, reply): Promise<RouteView> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role, routeId, tripId } = await guards.stop(user, id, "editor");
    const body = ctx.parse(createLegBody, req.body);
    const stored = await loadOrThrow(routeId);
    if (stored.route.version !== body.version) throw versionConflict(stored.route.version);
    const stop = stored.stops.find((s) => s.id === id)!;
    await requireHubs([body.from, body.to]);

    const existing = stop.legs;
    const maxSeq = existing.reduce((m, l) => Math.max(m, l.seq), -1);
    const seq = body.seq ?? maxSeq + 1;
    const isLast = seq > maxSeq;
    const legId = newId("lg");
    const version = await repos.routes.addLeg(
      id,
      body.version,
      {
        id: legId,
        seq,
        mode: body.mode,
        status: body.status,
        from: body.from.id,
        to: body.to.id,
        operator: body.operator ?? null,
        number: body.number ?? null,
        departAt: body.departAt ?? null,
        arriveAt: body.arriveAt ?? null,
        durationMin: body.durationMin ?? null,
        priceCad: body.priceCad ?? null,
        bookingRef: body.bookingRef ?? null,
        seat: body.seat ?? null,
        freeCancelUntil: body.freeCancelUntil ?? null,
      },
      isLast ? arriveModeFor(body.mode) : stop.arriveMode,
    );
    if (version !== null && !isLast) {
      // Inserting in the middle: shift the legs after it.
      await repos.routes.reseqLegs(
        id,
        existing.filter((l) => l.seq >= seq).map((l) => ({ legId: l.id, seq: l.seq + 1 })),
      );
    }
    const view = await afterWrite(routeId, version, role, { tripId, by: user.id });
    reply.status(201);
    return view;
  });

  /** A ticket home after the last stop. A booked one fixes the home date. */
  app.post("/routes/:id/home-legs", async (req, reply): Promise<RouteView> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role, tripId } = await guards.route(user, id, "editor");
    const body = ctx.parse(createLegBody, req.body);
    const stored = await loadOrThrow(id);
    if (stored.route.version !== body.version) throw versionConflict(stored.route.version);
    await requireHubs([body.from, body.to]);
    const maxSeq = stored.homeLegs.reduce((m, l) => Math.max(m, l.seq), -1);
    const version = await repos.routes.addHomeLeg(id, body.version, {
      id: newId("lg"),
      seq: maxSeq + 1,
      mode: body.mode,
      status: body.status,
      from: body.from.id,
      to: body.to.id,
      operator: body.operator ?? null,
      number: body.number ?? null,
      departAt: body.departAt ?? null,
      arriveAt: body.arriveAt ?? null,
      durationMin: body.durationMin ?? null,
      priceCad: body.priceCad ?? null,
      bookingRef: body.bookingRef ?? null,
      seat: body.seat ?? null,
      freeCancelUntil: body.freeCancelUntil ?? null,
    });
    const view = await afterWrite(id, version, role, { tripId, by: user.id });
    reply.status(201);
    return view;
  });

  app.patch("/legs/:id", async (req): Promise<RouteView> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role, routeId, tripId, stopId } = await guards.leg(user, id, "editor");
    const body = ctx.parse(patchLegBody, req.body);
    const refs = [body.from, body.to].filter((r): r is HubRef => r != null);
    if (refs.length) await requireHubs(refs);
    const stored = await loadOrThrow(routeId);
    const home = stopId === null;
    const stop = stored.stops.find((s) => s.id === stopId);
    const legs = home ? stored.homeLegs : (stop?.legs ?? []);
    const leg = legs.find((l) => l.id === id);
    const maxSeq = legs.reduce((m, l) => Math.max(m, l.seq), -1);
    const becomesLast = body.seq != null ? body.seq >= maxSeq : leg?.seq === maxSeq;
    const mode = body.mode ?? leg?.mode;
    const flag = (key: keyof typeof body) => ({ [`set${key[0]!.toUpperCase()}${key.slice(1)}`]: body[key] !== undefined, [key]: body[key] ?? null });
    const version = await repos.routes.patchLeg(id, body.version, {
      mode: body.mode ?? null,
      status: body.status ?? null,
      seq: body.seq ?? null,
      arriveMode: becomesLast && mode ? arriveModeFor(mode) : null,
      ...flag("operator"),
      ...flag("number"),
      ...flag("departAt"),
      ...flag("arriveAt"),
      ...flag("durationMin"),
      ...flag("priceCad"),
      ...flag("bookingRef"),
      ...flag("seat"),
      ...flag("freeCancelUntil"),
    }, home);
    if (version !== null) {
      if (body.from) await repos.routes.setLegHub(id, "from", body.from.id);
      if (body.to) await repos.routes.setLegHub(id, "to", body.to.id);
    }
    return afterWrite(routeId, version, role, { tripId, by: user.id });
  });

  app.delete("/legs/:id", async (req): Promise<RouteView> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role, routeId, tripId, stopId } = await guards.leg(user, id, "editor");
    const { version } = ctx.parse(versionQuery, req.query);
    const stored = await loadOrThrow(routeId);
    const remaining = (stored.stops.find((s) => s.id === stopId)?.legs ?? []).filter((l) => l.id !== id);
    const last = remaining.at(-1);
    return afterWrite(routeId, await repos.routes.deleteLeg(id, version, last ? arriveModeFor(last.mode) : null, stopId === null), role, {
      tripId,
      by: user.id,
    });
  });

  /** Booking reference and seat: editors and the owner only. */
  app.get("/legs/:id/private", async (req): Promise<LegPrivate> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.leg(user, id, "editor");
    const row = await repos.routes.legPrivate(id);
    if (!row) throw notFound("Leg");
    return row;
  });

  // --- stays (route-structure writes) ----------------------------------------

  /** Shortlist, choose or book a hotel for a stop. One chosen or booked hotel per stop. */
  app.put("/stops/:id/stays/:hotelId", async (req): Promise<RouteView> => {
    const user = ctx.user(req);
    const { id, hotelId } = ctx.parse(stayParams, req.params);
    const { role, routeId, tripId } = await guards.stop(user, id, "editor");
    const hotelAccess = await guards.hotel(user, hotelId, "viewer");
    if (hotelAccess.tripId !== tripId) throw notFound("Hotel");
    const body = ctx.parse(stayBody, req.body);
    const stored = await loadOrThrow(routeId);
    if (stored.route.version !== body.version) throw versionConflict(stored.route.version);
    const hotel = await repos.explorer.getHotel(tripId, user.id, hotelId);
    const stop = stored.stops.find((s) => s.id === id)!;
    if (!hotel) throw notFound("Hotel");
    if (hotel.cityCode !== stop.city.code) throw badRequest(`${hotel.name} is in ${hotel.cityName}, not ${stop.city.name}`);
    // A booking remembers the dates it was made for: the ones given, else the ones it already had, else the stop's.
    // Those dates become anchors the route builder works around.
    const dates = buildRouteView(stored, role).stops.find((s) => s.id === id)!;
    const existing = stop.stays.find((s) => s.hotel.id === hotelId && s.status === "booked");
    const arrive = body.arrive ?? existing?.arrive ?? dates.arrive;
    const depart = body.depart ?? existing?.depart ?? dates.depart;
    if (body.status === "booked" && arrive >= depart) throw badRequest("Check-out has to be after check-in");
    const version = await repos.routes.setStay(id, hotelId, body.version, {
      status: body.status,
      rooms: body.rooms ?? null,
      arrive: body.status === "booked" ? arrive : null,
      depart: body.status === "booked" ? depart : null,
      freeCancelUntil: body.status === "booked" ? (body.freeCancelUntil !== undefined ? (body.freeCancelUntil ?? null) : (existing?.freeCancelUntil ?? null)) : null,
    });
    if (version !== null && body.status !== "shortlist") await repos.routes.demoteOtherStays(id, hotelId);
    return afterWrite(routeId, version, role, { tripId, by: user.id });
  });

  app.delete("/stops/:id/stays/:hotelId", async (req): Promise<RouteView> => {
    const user = ctx.user(req);
    const { id, hotelId } = ctx.parse(stayParams, req.params);
    const { role, routeId, tripId } = await guards.stop(user, id, "editor");
    const { version } = ctx.parse(versionQuery, req.query);
    const stored = await loadOrThrow(routeId);
    if (!stored.stops.find((s) => s.id === id)?.stays.some((s) => s.hotel.id === hotelId)) throw notFound("Stay");
    return afterWrite(routeId, await repos.routes.deleteStay(id, hotelId, version), role, { tripId, by: user.id });
  });

  // --- areas ----------------------------------------------------------------

  app.get("/cities/:code/areas", async (req): Promise<Area[]> => {
    const user = ctx.user(req);
    const { code } = ctx.parse(z.object({ code: cityCode }), req.params);
    const { tripId } = ctx.parse(tripQuery, req.query);
    await guards.trip(user, tripId, "viewer");
    return repos.explorer.listAreas(tripId, user.id, { city: code });
  });

  app.post("/areas", async (req, reply): Promise<Area> => {
    const user = ctx.user(req);
    const body = ctx.parse(createAreaBody, req.body);
    await guards.trip(user, body.tripId, "editor");
    if (!(await repos.cities.get(body.cityCode))) throw notFound(`City ${body.cityCode}`);
    const id = await repos.explorer.createArea(user.id, body);
    ctx.notify(body.tripId, { kind: "activities" }, user.id);
    reply.status(201);
    return (await repos.explorer.getArea(body.tripId, user.id, id))!;
  });

  app.patch("/areas/:id", async (req): Promise<Area> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { tripId } = await guards.area(user, id, "editor");
    await repos.explorer.patchArea(id, ctx.parse(patchAreaBody, req.body));
    ctx.notify(tripId, { kind: "activities" }, user.id);
    return (await repos.explorer.getArea(tripId, user.id, id))!;
  });

  app.delete("/areas/:id", async (req, reply) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { tripId } = await guards.area(user, id, "editor");
    const area = await repos.explorer.getArea(tripId, user.id, id);
    if (area && area.hotelCount > 0) throw badRequest(`${area.name} still has hotels. Move or delete them first.`);
    await repos.explorer.deleteArea(id);
    ctx.notify(tripId, { kind: "activities" }, user.id);
    reply.status(204);
  });

  app.put("/areas/:id/vote", async (req): Promise<Area> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { tripId } = await guards.area(user, id, "viewer");
    const { value } = ctx.parse(voteBody, req.body);
    await repos.explorer.voteArea(user.id, id, value);
    ctx.notify(tripId, { kind: "activities" }, user.id);
    return (await repos.explorer.getArea(tripId, user.id, id))!;
  });

  // --- hotels -----------------------------------------------------------------

  app.get("/trips/:id/hotels", async (req): Promise<Hotel[]> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "viewer");
    const { city } = ctx.parse(z.object({ city: cityCode.optional() }), req.query);
    return repos.explorer.listHotels(id, user.id, city ? { city } : {});
  });

  app.post("/hotels", async (req, reply): Promise<Hotel> => {
    const user = ctx.user(req);
    const body = ctx.parse(createHotelBody, req.body);
    await guards.trip(user, body.tripId, "editor");
    const area = await guards.area(user, body.areaId, "viewer");
    if (area.tripId !== body.tripId) throw notFound("Area");
    const id = await repos.explorer.createHotel(user.id, body);
    ctx.notify(body.tripId, { kind: "activities" }, user.id);
    reply.status(201);
    return (await repos.explorer.getHotel(body.tripId, user.id, id))!;
  });

  app.patch("/hotels/:id", async (req): Promise<Hotel> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { tripId } = await guards.hotel(user, id, "editor");
    const { areaId, ...body } = ctx.parse(patchHotelBody, req.body);
    if (areaId) {
      const [current, target] = await Promise.all([
        repos.explorer.getHotel(tripId, user.id, id),
        repos.explorer.getArea(tripId, user.id, areaId),
      ]);
      if (!target) throw notFound("Area");
      // Stays point at stops in the hotel's city, so a hotel only moves between areas of that city.
      if (current && current.cityCode !== target.cityCode) throw badRequest("A hotel can only move to another area in the same city");
    }
    await repos.explorer.patchHotel(id, body);
    if (areaId) await repos.explorer.moveHotel(id, areaId);
    ctx.notify(tripId, { kind: "trip" }, user.id);
    return (await repos.explorer.getHotel(tripId, user.id, id))!;
  });

  app.delete("/hotels/:id", async (req, reply) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { tripId } = await guards.hotel(user, id, "editor");
    await repos.explorer.deleteHotel(id);
    // Removing a hotel also removes it from every stop that shortlisted or booked it.
    ctx.notify(tripId, { kind: "trip" }, user.id);
    reply.status(204);
  });

  app.put("/hotels/:id/vote", async (req): Promise<Hotel> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { tripId } = await guards.hotel(user, id, "viewer");
    const { value } = ctx.parse(voteBody, req.body);
    await repos.explorer.voteHotel(user.id, id, value);
    ctx.notify(tripId, { kind: "activities" }, user.id);
    return (await repos.explorer.getHotel(tripId, user.id, id))!;
  });
}
