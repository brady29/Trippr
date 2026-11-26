"use client";

import type { BookingItem, BookingsResult, LegBooking, StayBooking } from "@trippr/contracts";
import { dayDate, homeFlightLinks, hotelLinks, shortDate, travelLinks, type LinkMode } from "@trippr/rules";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { BookingLinks } from "@/components/booking-links";
import { ModeIcon } from "@/components/icons";
import { MapsLink } from "@/components/maps-link";
import { BoardHeader, BoardStat, RequireAuth } from "@/components/shell";
import { Button, ErrorNote, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { cad, useTripFlightPrices } from "@/lib/flights";
import { useAuth } from "@/lib/auth";
import { formatLegTime } from "@/lib/explorer";
import { useTrip } from "@/lib/queries";
import { routeHref } from "@/lib/routes";

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
          <span>{item.stopId === "home" ? `Getting home${item.cityName !== "home" ? ` to ${item.cityName}` : ""}` : `Into ${item.cityName} (stop ${item.stopOrder + 1})`}</span>
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
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-sky">
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

function SectionHeading({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-sm font-semibold">{children}</h2>
      {note ? <span className="text-xs text-ink-soft">{note}</span> : null}
    </div>
  );
}

function Bookings({ tripId }: { tripId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const routeId = params.get("route");
  const q = useBookings(tripId, routeId);
  const b = q.data;
  const trip = useTrip(tripId);
  // Latest flight fares are tracked for the current route only.
  const fares = useTripFlightPrices(tripId).data;
  const fareFor = (stopId: string) => (b?.route.isCurrent && fares?.enabled ? fares.items.find((i) => i.stopId === stopId && i.latestCad != null) : undefined);
  const stopCount = trip.data?.routes.find((r) => r.id === b?.route.id)?.stopCount;
  const ready = stopCount != null && b ? stopCount - b.toBook.length : null;
  const pct = stopCount && ready != null ? Math.round((ready / stopCount) * 100) : 0;

  return (
    <>
      <BoardHeader
        eyebrow={`${b?.trip.name ?? "Trip"} · bookings`}
        title="Bookings"
        width="max-w-5xl"
        meta={
          b ? (
            <>
              <BoardStat label="Booked" value={`${b.totals.bookedCount} item${b.totals.bookedCount === 1 ? "" : "s"}`} />
              <BoardStat label="Booked pp" value={money(b.totals.bookedPerPersonCad)} />
              <BoardStat label={`For ${b.trip.travellers}`} value={money(b.totals.bookedGroupCad)} />
            </>
          ) : null
        }
        actions={
          b ? (
            <>
              <label htmlFor="bookings-route" className="sr-only">
                Route
              </label>
              <select
                id="bookings-route"
                value={b.route.id}
                onChange={(e) => router.replace(`/trips/${tripId}/bookings?route=${encodeURIComponent(e.target.value)}`)}
                className="h-8 max-w-[14rem] rounded-lg border border-board-3 bg-board-2 px-2 text-xs font-medium text-amber-soft focus:outline-none"
              >
                {b.routes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.isCurrent ? " (current)" : ""}
                  </option>
                ))}
              </select>
              <Link href={routeHref(tripId, b.route.id)}>
                <Button size="sm" variant="board">
                  Open the route
                </Button>
              </Link>
            </>
          ) : null
        }
      />
      <main className="mx-auto max-w-5xl space-y-7 px-4 py-5 sm:px-6">
        {q.isPending ? <Spinner /> : null}
        {q.error ? <ErrorNote error={q.error} /> : null}
        {b ? (
          <>
            {/* Progress first: how much of the route is sorted. */}
            <section className="ticket p-4 sm:p-5" aria-label="Booking progress" data-testid="booking-progress">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">{b.route.name}</div>
                  <p className="mt-1 text-lg font-semibold">
                    {b.toBook.length === 0
                      ? "Every stop is booked"
                      : ready != null
                        ? `${ready} of ${stopCount} stops fully booked`
                        : `${b.toBook.length} stop${b.toBook.length === 1 ? "" : "s"} still to book`}
                  </p>
                </div>
                <dl className="flex gap-5 font-mono text-sm">
                  <div>
                    <dt className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">Booked pp</dt>
                    <dd className="font-semibold">{money(b.totals.bookedPerPersonCad)}</dd>
                  </div>
                  {b.pending.length ? (
                    <div>
                      <dt className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">Picked pp</dt>
                      <dd className="font-semibold">{money(b.totals.pendingPerPersonCad)}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
              {stopCount ? (
                <div
                  className="mt-3 h-2 overflow-hidden rounded-full bg-paper-2"
                  role="meter"
                  aria-label="Stops fully booked"
                  aria-valuemin={0}
                  aria-valuemax={stopCount}
                  aria-valuenow={ready ?? 0}
                >
                  <div className="h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
                </div>
              ) : null}
            </section>

            <section aria-labelledby="to-book-heading">
              <SectionHeading note={b.toBook.length ? "Search links are filled in with the dates and group size" : undefined}>
                <span id="to-book-heading">Still to book · {b.toBook.length + (b.homeToBook ? 1 : 0)}</span>
              </SectionHeading>
              {b.homeToBook ? (
                <div className="mb-3 rounded-2xl border border-line bg-card p-4" data-testid="home-to-book">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="grid h-7 w-7 place-items-center rounded-md bg-board font-mono text-xs font-semibold text-amber">⌂</span>
                    <Link href={`${routeHref(tripId, b.route.id)}#home-card`} className="font-semibold hover:underline">
                      Getting home
                    </Link>
                    <span className="font-mono text-xs text-ink-soft">
                      leave {b.homeToBook.fromCity.name} {shortDate(b.homeToBook.date)}
                    </span>
                    <span className="ml-auto rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">Flight home</span>
                  </div>
                  <p className="mt-2 text-xs text-ink-soft">A booked flight home fixes the home date, so the route builder keeps the last stretch of the trip the right length.</p>
                  {b.homeToBook.toCity ? (
                    <BookingLinks className="mt-1.5" label="Search:" links={homeFlightLinks(b.homeToBook.fromCity, b.homeToBook.toCity, b.homeToBook.date, b.trip.travellers)} />
                  ) : (
                    <p className="mt-1 text-xs text-ink-faint">Set the trip&apos;s home city to get search links.</p>
                  )}
                </div>
              ) : null}
              {b.toBook.length === 0 ? (
                <p className="rounded-2xl border border-line bg-card px-4 py-5 text-sm text-ok">Every stop has its transport and hotel booked.</p>
              ) : (
                <ul className="space-y-3" data-testid="to-book">
                  {b.toBook.map((t) => (
                    <li key={t.stopId} className="rounded-2xl border border-line bg-card p-4">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <span className="grid h-7 w-7 place-items-center rounded-md bg-board font-mono text-xs font-semibold text-amber">{t.stopOrder + 1}</span>
                        <Link href={routeHref(tripId, b.route.id, `stop-${t.stopId}`)} className="font-semibold hover:underline">
                          {t.cityName}
                        </Link>
                        <span className="font-mono text-xs text-ink-soft">
                          {shortDate(t.arrive)} → {shortDate(t.depart)}
                        </span>
                        <span className="ml-auto flex gap-1.5">
                          {t.needsTransport ? <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">Transport</span> : null}
                          {t.needsStay ? <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">Hotel</span> : null}
                        </span>
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        {t.needsTransport ? (
                          <div className="rounded-xl bg-paper p-3">
                            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
                              Getting there{t.fromCity ? ` from ${t.fromCity.name}` : ""}
                            </div>
                            {fareFor(t.stopId) ? (
                              <p className="mt-1 text-[11px] text-ink-soft" data-testid="to-book-fare">
                                Latest fare {cad(fareFor(t.stopId)!.latestCad)} per person ({fares!.sample ? "sample data, " : ""}
                                {fareFor(t.stopId)!.origin} to {fareFor(t.stopId)!.destination}, as of {shortDate(fareFor(t.stopId)!.asOf!)}). An estimate; check the airline.
                              </p>
                            ) : null}
                            {t.fromCity ? (
                              <BookingLinks
                                className="mt-1.5"
                                label="Search:"
                                links={travelLinks(t.arriveMode as LinkMode, t.fromCity, { code: t.cityCode, name: t.cityName, countryIso: t.countryIso }, t.arrive, b.trip.travellers)}
                              />
                            ) : (
                              <p className="mt-1 text-xs text-ink-soft">The first stop: book it from home.</p>
                            )}
                          </div>
                        ) : null}
                        {t.needsStay ? (
                          <div className="rounded-xl bg-paper p-3">
                            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">Where to sleep in {t.cityName}</div>
                            <BookingLinks
                              className="mt-1.5"
                              label="Hotels:"
                              links={hotelLinks({ code: t.cityCode, name: t.cityName, countryIso: t.countryIso }, t.arrive, t.depart, b.trip.travellers)}
                            />
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="booked-heading">
              <SectionHeading note={b.booked.length ? `${money(b.totals.bookedGroupCad)} for ${b.trip.travellers}` : undefined}>
                <span id="booked-heading">Booked · {b.booked.length}</span>
              </SectionHeading>
              {b.booked.length ? (
                <ItemList items={b.booked} travellers={b.trip.travellers} />
              ) : (
                <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-ink-soft">
                  Nothing booked on {b.route.name} yet. Mark a ticket or hotel as booked in the route editor and it shows up here.
                </p>
              )}
            </section>

            {b.pending.length ? (
              <section aria-labelledby="pending-heading">
                <SectionHeading note={`${money(b.totals.pendingPerPersonCad)} pp`}>
                  <span id="pending-heading">Picked, not booked yet · {b.pending.length}</span>
                </SectionHeading>
                <ItemList items={b.pending} travellers={b.trip.travellers} />
              </section>
            ) : null}
            {!b.canSeePrivate ? <p className="text-xs text-ink-faint">Booking references and seats are visible to editors and the owner.</p> : null}
          </>
        ) : null}
      </main>
    </>
  );
}

export default function BookingsPage() {
  const { tripId } = useParams<{ tripId: string }>();
  return (
    <RequireAuth>
      <Suspense fallback={<Spinner />}>
        <Bookings tripId={tripId} />
      </Suspense>
    </RequireAuth>
  );
}
