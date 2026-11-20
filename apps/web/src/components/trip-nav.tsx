"use client";

import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useTripLive } from "@/lib/live";
import { NavLink } from "./shell";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** Who else has this trip open right now. */
function Presence({ tripId }: { tripId: string }) {
  const { me } = useAuth();
  const { present, connected } = useTripLive(tripId);
  const others = present.filter((p) => p.id !== me?.id);
  if (!connected) return null;
  return (
    <span
      className="ml-1 flex shrink-0 items-center gap-1.5 pl-2 text-xs text-amber-soft/80"
      data-testid="presence"
      title={others.length ? `Also here: ${others.map((p) => p.name).join(", ")}` : "Live: changes from others appear automatically"}
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
      </span>
      <span className="sr-only">Live updates on.</span>
      {others.length ? (
        <span className="flex -space-x-1.5" aria-label={`Also here: ${others.map((p) => p.name).join(", ")}`}>
          {others.slice(0, 4).map((p) => (
            <span
              key={p.id}
              className="grid h-6 w-6 place-items-center rounded-full bg-amber font-mono text-[10px] font-semibold text-board ring-2 ring-board"
            >
              {initials(p.name)}
            </span>
          ))}
          {others.length > 4 ? (
            <span className="grid h-6 w-6 place-items-center rounded-full bg-board-3 text-[10px] ring-2 ring-board">
              +{others.length - 4}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="hidden sm:inline">Live</span>
      )}
    </span>
  );
}

export function TripNav({ tripId, tripName }: { tripId: string; tripName?: string }) {
  const path = usePathname();
  const base = `/trips/${tripId}`;
  return (
    <>
      <NavLink href={base} active={path === base}>
        {tripName ?? "Trip"}
      </NavLink>
      <NavLink href={`${base}/library`} active={path.startsWith(`${base}/library`)}>
        Activities
      </NavLink>
      <NavLink href={`${base}/itinerary`} active={path.startsWith(`${base}/itinerary`)}>
        Itinerary
      </NavLink>
      <NavLink href={`${base}/compare`} active={path.startsWith(`${base}/compare`)}>
        Compare
      </NavLink>
      <NavLink href={`${base}/graph`} active={path.startsWith(`${base}/graph`)}>
        Graph
      </NavLink>
      <NavLink href={`${base}/bookings`} active={path.startsWith(`${base}/bookings`)}>
        Booked
      </NavLink>
      <NavLink href={`${base}/inbox`} active={path.startsWith(`${base}/inbox`)}>
        Inbox
      </NavLink>
      <NavLink href={`${base}/paths`} active={path.startsWith(`${base}/paths`)}>
        Paths
      </NavLink>
      <Presence tripId={tripId} />
    </>
  );
}
