import { bookingsQuery, hasRole, type BookingItem, type BookingsResult, type Leg, type LegPrivate } from "@trippr/contracts";
import { daysBetween } from "@trippr/rules";
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
    const legItem = (leg: Leg, base: { stopId: string; stopOrder: number; cityCode: string; cityName: string }, fallbackDate: string): BookingItem => {
      const price = leg.priceCad ?? null;
      const ref = refs.get(leg.id);
      return {
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
        date: leg.departAt?.slice(0, 10) ?? fallbackDate,
        pricePerPersonCad: price,
        groupCad: price == null ? null : round2(price * travellers),
        ...(canSeePrivate ? { bookingRef: ref?.bookingRef ?? null, seat: ref?.seat ?? null } : {}),
      };
    };
    for (const stop of view.stops) {
      const base = { stopId: stop.id, stopOrder: stop.order, cityCode: stop.city.code, cityName: stop.city.name };
      for (const leg of stop.legs) items.push(legItem(leg, base, stop.arrive));
      for (const stay of stop.stays) {
        if (stay.status === "shortlist") continue;
        const nightly = stay.perPersonCadPerNight ?? null;
        // A booking keeps the dates it was made for, which can differ from the plan's.
        const checkIn = (stay.status === "booked" && stay.arrive) || stop.arrive;
        const checkOut = (stay.status === "booked" && stay.depart) || stop.depart;
        const nights = Math.max(0, daysBetween(checkIn, checkOut));
        const total = nightly == null ? null : round2(nightly * nights);
        items.push({
          ...base,
          kind: "stay",
          id: `${stop.id}:${stay.hotel.id}`,
          status: stay.status,
          hotelId: stay.hotel.id,
          hotelName: stay.hotel.name,
          areaName: stay.hotel.areaName,
          url: stay.hotel.url ?? null,
          checkIn,
          checkOut,
          nights,
          rooms: stay.rooms ?? null,
          perPersonPerNightCad: nightly,
          date: checkIn,
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

    // The trip home: after the last stop, into the home city.
    const last = view.stops.at(-1);
    const homeBase = { stopId: "home", stopOrder: view.stops.length, cityCode: home?.code ?? "", cityName: home?.name ?? "home" };
    for (const leg of view.homeLegs) items.push(legItem(leg, homeBase, view.checks.returnDate));
    const homeToBook: BookingsResult["homeToBook"] =
      last && !view.homeLegs.some((l) => l.status === "booked")
        ? {
            date: view.checks.returnDate,
            fromCity: { code: last.city.code, name: last.city.name, countryIso: last.city.countryIso },
            // The home city is free text when it isn't one of Trippr's cities ("Toronto").
            toCity: home
              ? { code: home.code, name: home.name, countryIso: home.countryIso }
              : view.trip.homeCity
                ? { code: view.trip.homeCity, name: view.trip.homeCity, countryIso: "" }
                : null,
          }
        : null;

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
      homeToBook,
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
