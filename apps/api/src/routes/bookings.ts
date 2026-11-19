import { bookingsQuery, hasRole, type BookingItem, type BookingsResult, type LegPrivate } from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { notFound } from "../errors";
import { cypher } from "../repositories/queries";
import { buildRouteView } from "../services/route-view";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function bookingsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { repos, guards, db } = ctx;

  /**
   * Everything booked on one route (the current route by default): legs and
   * hotel stays by date, what is picked but not booked yet, and the stops
   * still missing a booked hotel or transport.
   */
  app.get("/trips/:id/bookings", async (req): Promise<BookingsResult> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(z.object({ id: z.string().min(1) }), req.params);
    const { role } = await guards.trip(user, id, "viewer");
    const { routeId: wanted } = ctx.parse(bookingsQuery, req.query);

    const ids = await repos.trips.routeIds(id);
    const stored = (await Promise.all(ids.map((rid) => repos.routes.load(rid)))).filter((r) => r !== null);
    if (!stored.length) throw notFound("Route");
    const chosen = wanted
      ? stored.find((r) => r.route.id === wanted)
      : (stored.find((r) => r.route.isCurrent) ?? stored[0]);
    if (!chosen) throw notFound("Route");

    const view = buildRouteView(chosen, role);
    const travellers = view.trip.travellers ?? 1;
    const canSeePrivate = hasRole(role, "editor") && !user.isDemo;
    const refs = new Map<string, LegPrivate>();
    if (canSeePrivate) {
      const rows = await db.query<LegPrivate>(cypher("bookings/leg-refs", db.dialect), { routeId: chosen.route.id }, { readOnly: true });
      for (const r of rows) refs.set(r.id, r);
    }

    const home = view.trip.homeCity ? await repos.cities.get(view.trip.homeCity) : null;
    const items: BookingItem[] = [];
    const toBook: BookingsResult["toBook"] = [];
    for (const stop of view.stops) {
      const base = { stopId: stop.id, stopOrder: stop.order, cityCode: stop.city.code, cityName: stop.city.name };
      for (const leg of stop.legs) {
        const price = leg.priceCad ?? null;
        const ref = refs.get(leg.id);
        items.push({
          ...base,
          kind: "leg",
          id: leg.id,
          status: leg.status,
          mode: leg.mode,
          from: { id: leg.from.id, name: leg.from.name, kind: leg.from.kind },
          to: { id: leg.to.id, name: leg.to.name, kind: leg.to.kind },
          operator: leg.operator ?? null,
          number: leg.number ?? null,
          departAt: leg.departAt ?? null,
          arriveAt: leg.arriveAt ?? null,
          date: leg.departAt?.slice(0, 10) ?? stop.arrive,
          pricePerPersonCad: price,
          groupCad: price == null ? null : round2(price * travellers),
          ...(canSeePrivate ? { bookingRef: ref?.bookingRef ?? null, seat: ref?.seat ?? null } : {}),
        });
      }
      for (const stay of stop.stays) {
        if (stay.status === "shortlist") continue;
        const nightly = stay.perPersonCadPerNight ?? null;
        const total = nightly == null ? null : round2(nightly * stop.nights);
        items.push({
          ...base,
          kind: "stay",
          id: `${stop.id}:${stay.hotel.id}`,
          status: stay.status,
          hotelId: stay.hotel.id,
          hotelName: stay.hotel.name,
          areaName: stay.hotel.areaName,
          url: stay.hotel.url ?? null,
          checkIn: stop.arrive,
          checkOut: stop.depart,
          nights: stop.nights,
          rooms: stay.rooms ?? null,
          perPersonPerNightCad: nightly,
          date: stop.arrive,
          pricePerPersonCad: total,
          groupCad: total == null ? null : round2(total * travellers),
        });
      }
      const needsStay = stop.nights > 0 && !stop.stays.some((s) => s.status === "booked");
      const needsTransport = !stop.legs.some((l) => l.status === "booked");
      if (needsStay || needsTransport) {
        const prev = view.stops[view.stops.indexOf(stop) - 1]?.city ?? home;
        toBook.push({
          stopId: stop.id,
          stopOrder: stop.order,
          cityName: stop.city.name,
          cityCode: stop.city.code,
          countryIso: stop.city.countryIso,
          arrive: stop.arrive,
          depart: stop.depart,
          nights: stop.nights,
          needsStay,
          needsTransport,
          arriveMode: stop.arriveMode,
          fromCity: prev ? { code: prev.code, name: prev.name, countryIso: prev.countryIso } : null,
        });
      }
    }

    const byDate = (a: BookingItem, b: BookingItem) =>
      a.date.localeCompare(b.date) || a.stopOrder - b.stopOrder || (a.kind === b.kind ? 0 : a.kind === "leg" ? -1 : 1);
    const booked = items.filter((i) => i.status === "booked").sort(byDate);
    const pending = items.filter((i) => i.status === "held" || i.status === "chosen").sort(byDate);
    const sum = (list: BookingItem[], key: "pricePerPersonCad" | "groupCad") => round2(list.reduce((t, i) => t + (i[key] ?? 0), 0));

    return {
      trip: { id: view.trip.id, name: view.trip.name, travellers },
      route: { id: view.route.id, name: view.route.name, isCurrent: view.route.isCurrent },
      routes: stored.map((r) => ({ id: r.route.id, name: r.route.name, isCurrent: r.route.isCurrent })),
      canSeePrivate,
      booked,
      pending,
      toBook,
      totals: {
        bookedPerPersonCad: sum(booked, "pricePerPersonCad"),
        pendingPerPersonCad: sum(pending, "pricePerPersonCad"),
        bookedGroupCad: sum(booked, "groupCad"),
        bookedCount: booked.length,
        pendingCount: pending.length,
      },
    };
  });
}
