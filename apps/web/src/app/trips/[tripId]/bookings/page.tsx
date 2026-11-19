"use client";

import type { BookingItem, BookingsResult, LegBooking, StayBooking } from "@trippr/contracts";
import { dayDate, hotelLinks, shortDate, travelLinks, type LinkMode } from "@trippr/rules";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { BookingLinks } from "@/components/booking-links";
import { ModeIcon } from "@/components/icons";
import { MapsLink } from "@/components/maps-link";
import { BoardHeader, BoardStat, RequireAuth, TopBar } from "@/components/shell";
import { TripNav } from "@/components/trip-nav";
import { ErrorNote, Panel, Select, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatLegTime } from "@/lib/explorer";
import { useTrip } from "@/lib/queries";

const MODE_LABEL: Record<string, string> = { flight: "Flight", hsr: "High-speed train", train: "Train", road: "Road", boat: "Boat", maglev: "Maglev" };
const STATUS_STYLE: Record<string, string> = {
  booked: "bg-ok/15 text-ok",
  held: "bg-warn/15 text-warn",
  chosen: "bg-sky/15 text-sky",
};
const money = (n: number | null | undefined) => (n == null ? "price not set" : `$${Math.round(n).toLocaleString()}`);

function useBookings(tripId: string, routeId: string | null) {
  const ready = useAuth().status === "signedIn";
  return useQuery({
    queryKey: ["bookings", tripId, routeId ?? "current"],
    queryFn: () => api<BookingsResult>(`/trips/${tripId}/bookings${routeId ? `?routeId=${encodeURIComponent(routeId)}` : ""}`),
    enabled: ready,
  });
}

function LegCard({ item, travellers }: { item: LegBooking; travellers: number }) {
  return (
    <li className="ticket flex flex-col sm:flex-row" data-testid="booking-item" data-kind="leg">
      <div className="flex items-center gap-3 p-3 sm:w-44 sm:flex-col sm:items-start sm:justify-center sm:p-4">
        <ModeIcon mode={item.mode === "maglev" ? "train" : item.mode} className={item.mode === "flight" ? "h-6 w-6 text-sky" : "h-6 w-6 text-rail"} />
        <div>
          <div className="font-mono text-xs text-ink-faint">{dayDate(item.date)}</div>
          <div className="text-sm font-semibold">{MODE_LABEL[item.mode] ?? item.mode}</div>
        </div>
      </div>
      <div className="ticket-perf flex min-w-0 flex-1 flex-col gap-1.5 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-semibold">{item.from.name}</span>
          <MapsLink name={item.from.name} label="" />
          <span className="text-ink-faint">→</span>
          <span className="font-semibold">{item.to.name}</span>
          <MapsLink name={item.to.name} label="" />
          <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[item.status] ?? ""}`}>{item.status}</span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
          {item.operator || item.number ? <span>{[item.operator, item.number].filter(Boolean).join(" ")}</span> : null}
          {item.departAt ? <span>Departs {formatLegTime(item.departAt)}</span> : null}
          {item.arriveAt ? <span>Arrives {formatLegTime(item.arriveAt)}</span> : null}
          <span>
            Into {item.cityName} (stop {item.stopOrder + 1})
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="font-mono">
            {money(item.pricePerPersonCad)} pp{item.groupCad != null ? ` · ${money(item.groupCad)} for ${travellers}` : ""}
          </span>
          {item.bookingRef ? (
            <span>
              Ref <span className="font-mono font-semibold select-all">{item.bookingRef}</span>
            </span>
          ) : null}
          {item.seat ? (
            <span>
              Seat <span className="font-mono font-semibold">{item.seat}</span>
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function StayCard({ item, travellers }: { item: StayBooking; travellers: number }) {
  return (
    <li className="ticket flex flex-col sm:flex-row" data-testid="booking-item" data-kind="stay">
      <div className="flex items-center gap-3 p-3 sm:w-44 sm:flex-col sm:items-start sm:justify-center sm:p-4">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-[#2b6cb0]">
          <path d="M3 18V7M3 13h18v5M21 13a3 3 0 0 0-3-3h-7v3M7 11.5a1.5 1.5 0 1 0 0-.01" />
        </svg>
        <div>
          <div className="font-mono text-xs text-ink-faint">{dayDate(item.checkIn)}</div>
          <div className="text-sm font-semibold">Hotel · {item.nights} night{item.nights === 1 ? "" : "s"}</div>
        </div>
      </div>
      <div className="ticket-perf flex min-w-0 flex-1 flex-col gap-1.5 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {item.url ? (
            <a href={item.url} target="_blank" rel="noreferrer" className="font-semibold hover:underline">
              {item.hotelName}
            </a>
          ) : (
            <span className="font-semibold">{item.hotelName}</span>
          )}
          <MapsLink name={item.hotelName} near={`${item.areaName}, ${item.cityName}`} label="" />
          <span className="text-ink-soft">
            {item.areaName}, {item.cityName}
          </span>
          <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[item.status] ?? ""}`}>{item.status}</span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
          <span>
            Check in {dayDate(item.checkIn)} · check out {dayDate(item.checkOut)}
          </span>
          {item.rooms ? <span>{item.rooms} room{item.rooms === 1 ? "" : "s"}</span> : null}
        </div>
        <div className="font-mono text-xs">
          {item.perPersonPerNightCad != null ? `${money(item.perPersonPerNightCad)} pp a night · ` : ""}
          {money(item.pricePerPersonCad)} pp{item.groupCad != null ? ` · ${money(item.groupCad)} for ${travellers}` : ""}
        </div>
      </div>
    </li>
  );
}

function ItemList({ items, travellers }: { items: BookingItem[]; travellers: number }) {
  return (
    <ol className="space-y-3">
      {items.map((i) =>
        i.kind === "leg" ? <LegCard key={i.id} item={i} travellers={travellers} /> : <StayCard key={i.id} item={i} travellers={travellers} />,
      )}
    </ol>
  );
}

function Bookings({ tripId }: { tripId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const routeId = params.get("route");
  const q = useBookings(tripId, routeId);
  const b = q.data;

  return (
    <>
      <BoardHeader
        eyebrow={`${b?.trip.name ?? "Trip"} · bookings`}
        title="Booked"
        meta={
          b ? (
            <>
              <BoardStat label="Route" value={b.route.name} />
              <BoardStat label="Booked" value={`${b.totals.bookedCount} item${b.totals.bookedCount === 1 ? "" : "s"}`} />
              <BoardStat label="Booked pp" value={money(b.totals.bookedPerPersonCad)} />
              <BoardStat label={`For ${b.trip.travellers}`} value={money(b.totals.bookedGroupCad)} />
              <BoardStat label="Still to book" value={`${b.toBook.length} stop${b.toBook.length === 1 ? "" : "s"}`} />
            </>
          ) : null
        }
      />
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="space-y-6">
          {b ? (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="bookings-route" className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">
                Route
              </label>
              <Select
                id="bookings-route"
                value={b.route.id}
                onChange={(e) => router.replace(`/trips/${tripId}/bookings?route=${encodeURIComponent(e.target.value)}`)}
              >
                {b.routes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.isCurrent ? " (current)" : ""}
                  </option>
                ))}
              </Select>
              <Link href={`/routes/${b.route.id}`} className="text-sm font-medium text-sky hover:underline">
                Open in route editor
              </Link>
            </div>
          ) : null}
          {q.isPending ? <Spinner /> : null}
          {q.error ? <ErrorNote error={q.error} /> : null}
          {b ? (
            <>
              <div>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">Booked</h2>
                {b.booked.length ? (
                  <ItemList items={b.booked} travellers={b.trip.travellers} />
                ) : (
                  <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-ink-soft">
                    Nothing booked on {b.route.name} yet. Mark a ticket or hotel as booked in the route editor and it shows up here.
                  </p>
                )}
              </div>
              {b.pending.length ? (
                <div>
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">
                    Picked, not booked yet ({money(b.totals.pendingPerPersonCad)} pp)
                  </h2>
                  <ItemList items={b.pending} travellers={b.trip.travellers} />
                </div>
              ) : null}
              {!b.canSeePrivate ? (
                <p className="text-xs text-ink-faint">Booking references and seats are visible to editors and the owner.</p>
              ) : null}
            </>
          ) : null}
        </section>
        <aside>
          {b ? (
            <Panel title={`Still to book (${b.toBook.length})`}>
              {b.toBook.length === 0 ? (
                <p className="text-sm text-ok">Every stop has its transport and hotel booked.</p>
              ) : (
                <ul className="space-y-2" data-testid="to-book">
                  {b.toBook.map((t) => (
                    <li key={t.stopId} className="flex flex-wrap items-center gap-2 text-sm">
                      <Link href={`/routes/${b.route.id}#stop-${t.stopId}`} className="font-medium hover:underline">
                        {t.stopOrder + 1}. {t.cityName}
                      </Link>
                      <span className="font-mono text-xs text-ink-faint">{shortDate(t.arrive)}</span>
                      <span className="ml-auto flex gap-1">
                        {t.needsTransport ? <span className="rounded-full border border-dashed border-ink-faint px-1.5 text-[10px] text-ink-soft">transport</span> : null}
                        {t.needsStay ? <span className="rounded-full border border-dashed border-ink-faint px-1.5 text-[10px] text-ink-soft">hotel</span> : null}
                      </span>
                      {t.needsTransport && t.fromCity ? (
                        <BookingLinks
                          className="w-full"
                          label={`From ${t.fromCity.name}:`}
                          links={travelLinks(t.arriveMode as LinkMode, t.fromCity, { code: t.cityCode, name: t.cityName, countryIso: t.countryIso }, t.arrive, b.trip.travellers)}
                        />
                      ) : null}
                      {t.needsStay ? (
                        <BookingLinks
                          className="w-full"
                          label="Hotels:"
                          links={hotelLinks({ code: t.cityCode, name: t.cityName, countryIso: t.countryIso }, t.arrive, t.depart, b.trip.travellers)}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          ) : null}
        </aside>
      </main>
    </>
  );
}

export default function BookingsPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const trip = useTrip(tripId);
  return (
    <>
      <TopBar>
        <TripNav tripId={tripId} tripName={trip.data?.trip.name} />
      </TopBar>
      <RequireAuth>
        <Suspense fallback={<Spinner />}>
          <Bookings tripId={tripId} />
        </Suspense>
      </RequireAuth>
    </>
  );
}
