"use client";

import { googleMapsUrl } from "@trippr/contracts";
import { PinIcon } from "./icons";

/** "Open in Google Maps" for any place: an activity, city, station, airport, area or hotel. */
export function MapsLink({
  query,
  name,
  near,
  lat,
  lon,
  label = "Map",
  className = "",
}: {
  query?: string | null;
  name?: string;
  near?: string | null;
  lat?: number | null;
  lon?: number | null;
  label?: string;
  className?: string;
}) {
  const title = query || [name, near].filter(Boolean).join(", ");
  return (
    <a
      href={googleMapsUrl({ query, name, near, lat, lon })}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center gap-1 text-sky hover:underline ${className}`}
      aria-label={`Open ${title} in Google Maps`}
      title={`Open ${title} in Google Maps`}
    >
      <PinIcon className="h-3.5 w-3.5" />
      {label ? <span>{label}</span> : null}
    </a>
  );
}
