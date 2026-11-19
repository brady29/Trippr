import type { BookingsResult, LegBooking, RouteView, StayBooking } from "@trippr/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, signIn, startHarness, type Harness } from "./harness";

const TRIP = "asia-2027";
const MAIN = "route-main";
let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;
let viewer: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  h = await startHarness();
  owner = await signIn(h.app, "Booking Owner");
  viewer = await signIn(h.app, "Booking Viewer");
  await owner.api.post(`/invites/${h.ownerInvite}/accept`);
  const invite = await owner.api.post(`/trips/${TRIP}/invites`, { role: "viewer" });
  await viewer.api.post(`/invites/${invite.body.token}/accept`);
});

afterAll(async () => {
  await h?.close();
});

describe("GET /trips/:id/bookings", () => {
  it("lists booked legs and hotels by date with totals, and what is still to book", async () => {
    let view = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
    const sia = view.stops.find((s) => s.city.code === "SIA")!;

    // Book the train into Xi'an.
    let res = await owner.api.post<RouteView>(`/stops/${sia.id}/legs`, {
      mode: "hsr",
      from: { kind: "station", id: "stn-beijing-west" },
      to: { kind: "station", id: "stn-xian-north" },
      operator: "China Railway",
      number: "G87",
      departAt: `${sia.arrive}T08:00+08:00`,
      priceCad: 110,
      status: "booked",
      bookingRef: "E12345678",
      seat: "07A",
      version: view.route.version,
    });
    expect(res.status).toBe(201);
    view = res.body;

    // Book a hotel in Xi'an.
    const area = await owner.api.post<{ id: string }>("/areas", { tripId: TRIP, cityCode: "SIA", name: "Bell Tower" });
    const hotel = await owner.api.post<{ id: string }>("/hotels", { tripId: TRIP, areaId: area.body.id, name: "Test Hotel Xi'an", priceCadPerNight: 100, sleeps: 2 });
    res = await owner.api.put<RouteView>(`/stops/${sia.id}/stays/${hotel.body.id}`, { status: "booked", version: view.route.version });
    expect(res.status).toBe(200);

    const b = (await owner.api.get<BookingsResult>(`/trips/${TRIP}/bookings`)).body;
    expect(b.route).toMatchObject({ id: MAIN, isCurrent: true });
    expect(b.canSeePrivate).toBe(true);
    expect(b.booked.map((i) => i.kind)).toEqual(["leg", "stay"]);
    const leg = b.booked[0] as LegBooking;
    expect(leg).toMatchObject({ cityCode: "SIA", number: "G87", bookingRef: "E12345678", seat: "07A", pricePerPersonCad: 110 });
    const stay = b.booked[1] as StayBooking;
    // $100 a room shared by 2 = $50 a night, for the stop's 3 nights.
    expect(stay).toMatchObject({ hotelName: "Test Hotel Xi'an", checkIn: sia.arrive, checkOut: sia.depart, nights: 3, perPersonPerNightCad: 50, pricePerPersonCad: 150 });
    expect(b.totals).toMatchObject({ bookedCount: 2, bookedPerPersonCad: 260 });
    expect(b.toBook.find((t) => t.stopId === sia.id)).toBeUndefined();
    expect(b.toBook.length).toBe(view.stops.length - 1);
  });

  it("hides booking references and seats from viewers", async () => {
    const res = await viewer.api.get<BookingsResult>(`/trips/${TRIP}/bookings`);
    expect(res.status).toBe(200);
    expect(res.body.canSeePrivate).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("E12345678");
    expect(JSON.stringify(res.body)).not.toContain("07A");
  });

  it("switches routes and refuses non-members", async () => {
    const res = await owner.api.get<BookingsResult>(`/trips/${TRIP}/bookings?routeId=route-with-shanghai`);
    expect(res.body.route.id).toBe("route-with-shanghai");
    expect(res.body.booked).toEqual([]);
    expect(res.body.routes.length).toBeGreaterThanOrEqual(2);
    expect((await owner.api.get(`/trips/${TRIP}/bookings?routeId=nope`)).status).toBe(404);
    const stranger = await signIn(h.app, "Booking Stranger");
    expect((await stranger.api.get(`/trips/${TRIP}/bookings`)).status).toBe(404);
    expect((await client(h.app).get(`/trips/${TRIP}/bookings`)).status).toBe(401);
  });
});
