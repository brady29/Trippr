"use client";

import type { RouteView } from "@trippr/contracts";
import { dayDate, homeFlightLinks, shortDate, type AnchorState } from "@trippr/rules";
import type { ReactNode } from "react";
import { useCitySearch } from "@/lib/queries";
import { BookingLinks } from "./booking-links";
import { HomeIcon, LockIcon } from "./icons";
import { HomeLegs } from "./stop-legs";

/**
 * After the last stop: the home date and the tickets home. A booked ticket
 * home fixes the home date, so the last stretch of the trip can't grow
 * without moving it.
 */
export function HomeCard({
  view,
  pin,
  canEdit,
  pricesOn,
  openNew,
  onSearch,
  issues,
}: {
  view: RouteView;
  pin?: AnchorState;
  canEdit: boolean;
  pricesOn: boolean;
  openNew?: number;
  /** Someone opened a search link for the flight home (for "Did you book it?"). */
  onSearch?: () => void;
  /** The home-day check, with its fixes. */
  issues?: ReactNode;
}) {
  const last = view.stops.at(-1);
  const homeName = view.trip.homeCity?.trim() ?? "";
  const cities = useCitySearch(homeName);
  // The home city is free text ("Toronto"); a known city adds its code for the searches.
  const known = cities.data?.find((c) => c.code === homeName.toUpperCase() || c.name.toLowerCase() === homeName.toLowerCase());
  const homeCode = known?.code ?? "";
  const booked = view.homeLegs.some((l) => l.status === "booked");
  if (!last) return null;
  return (
    <section className="ticket grid grid-cols-1 sm:grid-cols-[104px_minmax(0,1fr)]" aria-label="Getting home" data-testid="home-card" data-fixed={Boolean(pin?.strength === "booked")}>
      <div className="flex items-center gap-3 border-b-2 border-dashed border-line px-3 py-2.5 sm:flex-col sm:items-start sm:gap-2 sm:border-b-0 sm:border-r-2 sm:py-3.5">
        <HomeIcon className="h-5 w-5 text-ink-soft" />
        <div className="text-sm font-semibold">Home</div>
        {homeName ? <div className="text-xs text-ink-soft">{known?.name ?? homeName}</div> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-mono text-sm font-medium" data-testid="home-date">
            Leave {last.city.name} {dayDate(view.checks.returnDate)}
          </div>
          {pin ? (
            <span
              data-testid="home-pin"
              data-holds={pin.holds}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs ${
                !pin.holds ? "bg-err/10 text-err" : pin.strength === "soft" ? "border border-dashed border-ink-faint text-ink-soft" : "bg-ok/10 text-ok"
              }`}
            >
              <LockIcon className="h-3 w-3" />
              {pin.strength === "soft" ? "Held · " : ""}
              {pin.label} <span className="font-mono">{shortDate(pin.from)}</span>
              {!pin.holds ? <span className="font-medium">· plan says {shortDate(pin.planDate)}</span> : null}
            </span>
          ) : null}
        </div>
        {issues}
        <HomeLegs
          routeId={view.route.id}
          legs={view.homeLegs}
          lastCityCode={last.city.code}
          homeCityCode={homeCode || null}
          canEdit={canEdit}
          pricesOn={pricesOn}
          openNew={openNew}
        />
        {!booked && homeName ? (
          <div onClickCapture={(e) => (e.target as HTMLElement).closest("a") && onSearch?.()}>
            <BookingLinks
              label="Search flights home:"
              links={homeFlightLinks({ code: last.city.code, name: last.city.name, countryIso: last.city.countryIso }, known ?? homeName, view.checks.returnDate, view.trip.travellers ?? 1)}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
