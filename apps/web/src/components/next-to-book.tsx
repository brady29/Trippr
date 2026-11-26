"use client";

import type { City, RouteView } from "@trippr/contracts";
import { homeFlightLinks, hotelLinks, shortDate, travelLinks, type BookingLink, type LinkMode, type NextToBookItem } from "@trippr/rules";
import { useEffect, useRef, useState } from "react";
import { BookingLinks } from "./booking-links";
import { Button, Panel } from "./ui";

/** The search links for one item, filled in with its cities, dates and group size. */
export function linksFor(item: NextToBookItem, view: RouteView, homeCity: City | undefined): BookingLink[] {
  const travellers = view.trip.travellers ?? 1;
  const city = (s: RouteView["stops"][number]) => ({ code: s.city.code, name: s.city.name, countryIso: s.city.countryIso });
  const homeName = view.trip.homeCity?.trim();
  if (item.kind === "home") {
    const last = view.stops.at(-1);
    const to = homeCity ?? homeName;
    return last && to ? homeFlightLinks(city(last), to, view.checks.returnDate, travellers) : [];
  }
  const i = view.stops.findIndex((s) => s.id === item.stopId);
  const stop = view.stops[i];
  if (!stop) return [];
  if (item.kind === "stay") return hotelLinks(city(stop), stop.arrive, stop.depart, travellers);
  const prev = view.stops[i - 1];
  if (prev) return travelLinks(stop.arriveMode as LinkMode, city(prev), city(stop), stop.arrive, travellers);
  // The first stop is reached from home; the same rule applies to the city code as for the flight home.
  const from = homeCity ?? homeName;
  if (!from) return [];
  return stop.arriveMode === "flight"
    ? homeFlightLinks(from, city(stop), stop.arrive, travellers)
    : travelLinks(stop.arriveMode as LinkMode, typeof from === "string" ? { code: from, name: from } : from, city(stop), stop.arrive, travellers);
}

/**
 * What to book next on this route, most at risk first: the flight home,
 * flights, nights around a fixed-date event, anything held or chosen.
 */
export function NextToBook({
  items,
  view,
  homeCity,
  canEdit,
  onSearch,
  onMark,
}: {
  items: NextToBookItem[];
  view: RouteView;
  homeCity: City | undefined;
  canEdit: boolean;
  onSearch: (item: NextToBookItem) => void;
  onMark: (item: NextToBookItem) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const key = (i: NextToBookItem) => `${i.kind}:${i.stopId ?? "home"}`;
  const shown = all ? items : items.slice(0, 3);
  if (!items.length) {
    return (
      <Panel title="Next to book">
        <p className="text-sm text-ok" data-testid="next-to-book-done">
          Everything on this route is booked.
        </p>
      </Panel>
    );
  }
  return (
    <Panel title="Next to book" action={<span className="font-mono text-xs text-ink-faint">{items.length} left</span>}>
      <ol className="space-y-2" data-testid="next-to-book">
        {shown.map((item, n) => {
          const links = linksFor(item, view, homeCity);
          const isOpen = open === key(item);
          return (
            <li key={key(item)} className="rounded-xl bg-paper p-2.5" data-testid="next-item" data-kind={item.kind}>
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 font-mono text-xs font-semibold text-ink-faint">{n + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold leading-snug">
                    {item.title} <span className="font-mono text-xs font-normal text-ink-soft">{shortDate(item.date)}</span>
                  </div>
                  <p className="text-xs text-ink-soft">{item.reasons[0]}</p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 pl-5">
                {links.length ? (
                  <Button size="sm" onClick={() => setOpen(isOpen ? null : key(item))} aria-expanded={isOpen}>
                    Search
                  </Button>
                ) : null}
                {canEdit ? (
                  <Button size="sm" variant="ghost" onClick={() => onMark(item)}>
                    I booked it
                  </Button>
                ) : null}
              </div>
              {isOpen ? (
                <div className="mt-2 pl-5" onClickCapture={(e) => (e.target as HTMLElement).closest("a") && onSearch(item)}>
                  <BookingLinks label="Open:" links={links} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {items.length > 3 ? (
        <button onClick={() => setAll((a) => !a)} className="mt-2 text-xs font-medium text-sky hover:underline">
          {all ? "Show the top 3" : `Show all ${items.length}`}
        </button>
      ) : null}
    </Panel>
  );
}

/**
 * Remembers which search someone opened; when they come back to the tab, asks
 * whether they booked it. Kept for this tab only.
 */
export function useBookedPrompt() {
  const [asking, setAsking] = useState<NextToBookItem | null>(null);
  const opened = useRef<{ item: NextToBookItem; at: number } | null>(null);
  useEffect(() => {
    const back = () => {
      const o = opened.current;
      if (document.visibilityState !== "visible" || !o || Date.now() - o.at < 1500) return;
      opened.current = null;
      setAsking(o.item);
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, []);
  return {
    asking,
    opened: (item: NextToBookItem) => (opened.current = { item, at: Date.now() }),
    dismiss: () => setAsking(null),
  };
}

export function BookedPrompt({ item, onYes, onNo }: { item: NextToBookItem; onYes: () => void; onNo: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-ok/40 bg-ok/10 px-3 py-2.5 text-sm" role="status" data-testid="booked-prompt">
      <span className="min-w-0 flex-1 basis-56">
        Welcome back. Did you book the <span className="font-semibold">{item.title.toLowerCase()}</span>?
      </span>
      <Button size="sm" variant="primary" onClick={onYes}>
        Yes, add it
      </Button>
      <Button size="sm" variant="ghost" onClick={onNo}>
        Not yet
      </Button>
    </div>
  );
}
