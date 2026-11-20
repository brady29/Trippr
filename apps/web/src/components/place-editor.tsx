"use client";

import type { Activity } from "@trippr/contracts";
import type { PlaceStatus } from "@trippr/rules";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useLookupPlace, useSetPlace } from "@/lib/queries";
import { useToast } from "./toast";
import { Button, ErrorNote, Input } from "./ui";

const PlaceMap = dynamic(() => import("./place-map"), {
  ssr: false,
  loading: () => <div className="h-48 w-full animate-pulse rounded-lg bg-paper-2" />,
});

export const PLACE_STATUS_LABEL: Record<PlaceStatus, string> = {
  placed: "On the map",
  check: "Check the pin: it's a fair way from the city",
  manual: "Pinned by hand",
  not_found: "Couldn't find it on the map",
  unplaced: "Not on the map yet",
};

const LOOKUP_TOAST = {
  placed: "Found it and put it on the map",
  check: "Found a match a fair way from the city. Check the pin",
  not_found: "Couldn't find it. Paste a Google Maps link instead",
  skipped: "It's pinned by hand, so it was left alone",
} as const;

/** Where an activity is: find it on OpenStreetMap, paste a map link, drag the pin, or remove it. */
export function PlaceEditor({ activity, onClose }: { activity: Activity; onClose?: () => void }) {
  const lookup = useLookupPlace();
  const setPlace = useSetPlace();
  const toast = useToast();
  const [link, setLink] = useState("");
  const status = activity.placeStatus ?? "unplaced";
  const pinned = activity.lat != null && activity.lon != null;
  const error = lookup.error ?? setPlace.error;

  return (
    <div className="mt-2 space-y-2 rounded-lg bg-paper p-2.5 text-sm" data-testid="place-editor">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-xs font-medium ${status === "check" || status === "not_found" ? "text-stamp" : "text-ink-soft"}`} data-testid="place-status">
          {PLACE_STATUS_LABEL[status]}
        </span>
        {activity.address ? <span className="truncate text-xs text-ink-faint">{activity.address}</span> : null}
      </div>
      {pinned ? (
        <PlaceMap
          lat={activity.lat!}
          lon={activity.lon!}
          label={activity.title}
          onMove={(point) => setPlace.mutate({ id: activity.id, body: point }, { onSuccess: () => toast("Pin moved") })}
        />
      ) : null}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!link.trim()) return;
          setPlace.mutate({ id: activity.id, body: { link: link.trim() } }, { onSuccess: () => setLink("") });
        }}
      >
        <Input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Paste a Google Maps link or 35.6595, 139.7004"
          aria-label={`Pin location for ${activity.title}`}
          className="h-9"
        />
        <Button size="sm" type="submit" disabled={setPlace.isPending || !link.trim()} className="h-9">
          Set pin
        </Button>
      </form>
      <div className="flex flex-wrap gap-2">
        {status !== "manual" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={lookup.isPending}
            onClick={() => lookup.mutate(activity.id, { onSuccess: (r) => toast(LOOKUP_TOAST[r.outcome], r.outcome === "not_found" ? "error" : undefined) })}
          >
            {lookup.isPending ? "Looking…" : pinned ? "Find again" : "Find on map"}
          </Button>
        ) : null}
        {pinned || status === "not_found" ? (
          <Button size="sm" variant="ghost" disabled={setPlace.isPending} onClick={() => setPlace.mutate({ id: activity.id, body: { clear: true } })}>
            Remove pin
          </Button>
        ) : null}
        {onClose ? (
          <Button size="sm" variant="ghost" onClick={onClose} className="ml-auto">
            Done
          </Button>
        ) : null}
      </div>
      {pinned ? <p className="text-xs text-ink-faint">Drag the pin to move it. Map data © OpenStreetMap contributors.</p> : null}
      {error ? <ErrorNote error={error} /> : null}
    </div>
  );
}
