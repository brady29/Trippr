import type { FlightPriceHistory, TripFlightPrices } from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { notFound } from "../errors";
import { buildRouteView } from "../services/route-view";
import { flightHops } from "../services/flights/service";

/**
 * Flight price history and the booking signal. Anyone on the trip can read
 * them (viewers included, the demo account too); only the daily job writes.
 */
export function flightRoutes(app: FastifyInstance, ctx: AppContext) {
  const { repos, guards, flights } = ctx;

  /** Price history, the latest window of nearby dates and the booking signal for one flight leg. */
  app.get("/legs/:id/flight-prices", async (req): Promise<FlightPriceHistory> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(z.object({ id: z.string().min(1) }), req.params);
    const found = await guards.leg(user, id, "viewer");
    if (!flights.enabled) return flights.history(null, id, 1);
    const stored = await repos.routes.load(found.routeId);
    if (!stored) throw notFound("Route");
    const view = buildRouteView(stored, found.role);
    const hop = flightHops(view).find((h) => h.legId === id) ?? null;
    return flights.history(hop, id, view.trip.travellers ?? 1);
  });

  /** The trip's current route: each flight's latest price and signal, and any price-drop notices. */
  app.get("/trips/:id/flight-prices", async (req): Promise<TripFlightPrices> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(z.object({ id: z.string().min(1) }), req.params);
    const { role } = await guards.trip(user, id, "viewer");
    if (!flights.enabled) return flights.tripSummary(null);
    const ids = await repos.trips.routeIds(id);
    const stored = (await Promise.all(ids.map((rid) => repos.routes.load(rid)))).filter((r) => r !== null);
    const chosen = stored.find((r) => r.route.isCurrent) ?? stored[0];
    if (!chosen) throw notFound("Route");
    return flights.tripSummary(buildRouteView(chosen, role));
  });
}
