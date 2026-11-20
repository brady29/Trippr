"use client";

import type { Activity } from "@trippr/contracts";
import { placeLinks, type PlaceLinkKind } from "@trippr/rules";
import { PinIcon } from "./icons";

const MAP_KINDS: PlaceLinkKind[] = ["google-maps", "apple-maps", "amap"];

/** The parts of an activity the links are built from (an inbox suggestion has these too). */
export type PlaceLinksFor = Pick<
  Activity,
  "title" | "cityName" | "countryIso" | "mapsQuery" | "address" | "lat" | "lon" | "url" | "website" | "ticketUrl" | "reserveUrl" | "mapsUrl"
>;

/** Website, tickets, reservations, map apps and the source, for one activity. */
export function PlaceLinks({ activity, className = "" }: { activity: PlaceLinksFor; className?: string }) {
  const links = placeLinks({
    title: activity.title,
    cityName: activity.cityName,
    countryIso: activity.countryIso,
    mapsQuery: activity.mapsQuery,
    address: activity.address,
    lat: activity.lat,
    lon: activity.lon,
    url: activity.url,
    website: activity.website,
    ticketUrl: activity.ticketUrl,
    reserveUrl: activity.reserveUrl,
    mapsUrl: activity.mapsUrl,
  });
  return (
    <span className={`inline-flex flex-wrap items-center gap-x-3 gap-y-1 ${className}`} data-testid="place-links">
      {links.map((l) => (
        <a
          key={l.kind}
          href={l.url}
          target="_blank"
          rel="noreferrer"
          data-kind={l.kind}
          className="inline-flex items-center gap-1 text-sky hover:underline"
          aria-label={`${l.label}: ${activity.title}`}
        >
          {MAP_KINDS.includes(l.kind) ? <PinIcon className="h-3.5 w-3.5" /> : null}
          <span>{l.label}</span>
        </a>
      ))}
    </span>
  );
}
