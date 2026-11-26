"use client";

import { useDialogFocus } from "@/lib/focus";
import type { StopView } from "@trippr/contracts";
import { activityLinks, dayDate } from "@trippr/rules";
import { useRef } from "react";
import { usePlanToggle, useRouteLibrary } from "@/lib/queries";
import { ActivityItem, NewActivityForm } from "./activity";
import { BookingLinks } from "./booking-links";
import { SuggestedForStop } from "./suggested-for-stop";
import { XIcon } from "./icons";
import { ErrorNote, Spinner } from "./ui";

/**
 * A drawer per stop: the city's shared activities (the same list every route
 * through this city sees), with planned toggles, votes and comments.
 */
export function ActivityDrawer({
  routeId,
  tripId,
  stop,
  canEdit,
  canVote,
  onClose,
}: {
  routeId: string;
  tripId: string;
  stop: StopView;
  canEdit: boolean;
  canVote: boolean;
  onClose: () => void;
}) {
  const library = useRouteLibrary(routeId);
  const toggle = usePlanToggle(routeId);
  const panel = useRef<HTMLDivElement>(null);
  const activities = library.data?.find((l) => l.stopId === stop.id)?.activities ?? [];

  useDialogFocus(panel, onClose);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Activities in ${stop.city.name}`}>
      <button className="absolute inset-0 bg-board/40" aria-label="Close activities" onClick={onClose} />
      <div ref={panel} tabIndex={-1} className="relative flex h-full w-full max-w-md flex-col bg-paper shadow-2xl focus:outline-none">
        <div className="bg-board px-4 py-4 text-amber-soft">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-amber-soft/60">Shared library</div>
              <div className="mt-1 text-xl font-semibold text-amber">
                {stop.city.name} <span className="font-mono text-sm text-amber-soft/70">{stop.city.code}</span>
              </div>
              <div className="font-mono text-xs text-amber-soft/70">
                {dayDate(stop.arrive)} → {dayDate(stop.depart)}
              </div>
            </div>
            <button onClick={onClose} className="rounded p-1.5 hover:bg-board-3" aria-label="Close">
              <XIcon />
            </button>
          </div>
          <p className="mt-2 text-xs text-amber-soft/70">
            Activities belong to the city, so every route through {stop.city.name} sees this list. Ticking one plans it for this route.
          </p>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <BookingLinks
            label="Tours and tickets on"
            links={activityLinks({ code: stop.city.code, name: stop.city.name, countryIso: stop.city.countryIso })}
          />
          {library.isPending ? <Spinner /> : null}
          {library.error ? <ErrorNote error={library.error} /> : null}
          {library.data && activities.length === 0 ? (
            <p className="text-sm text-ink-soft">Nothing in {stop.city.name} yet. Add the first idea below.</p>
          ) : null}
          <ul className="space-y-2">
            {activities.map((a) => (
              <ActivityItem
                key={a.id}
                activity={a}
                canVote={canVote}
                canEdit={canEdit}
                leading={
                  <input
                    type="checkbox"
                    checked={a.planned}
                    disabled={!canEdit}
                    onChange={(e) =>
                      toggle.mutate({ stopId: stop.id, activityId: a.id, planned: e.target.checked, title: a.title })
                    }
                    aria-label={`Plan ${a.title} for this stop`}
                    className="mt-1 h-4 w-4 accent-ok"
                  />
                }
              />
            ))}
          </ul>
          <SuggestedForStop
            tripId={tripId}
            routeId={routeId}
            stopId={stop.id}
            cityName={stop.city.name}
            canEdit={canEdit}
            canVote={canVote}
          />
          {canEdit ? <NewActivityForm tripId={tripId} cityCode={stop.city.code} cityName={stop.city.name} /> : null}
        </div>
      </div>
    </div>
  );
}
