"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
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

// The Ask panel (and its streaming code) loads only when someone opens it.
const AssistantPanel = dynamic(() => import("./assistant-panel"), { ssr: false });

/** Opens the trip assistant; stays in view at the end of the scrolling nav on phones. */
function AskButton({ tripId }: { tripId: string }) {
  const { status } = useAuth();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (status !== "signedIn") return null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        data-testid="ask-button"
        className="sticky right-0 ml-1 shrink-0 rounded-md bg-amber px-2.5 py-1 font-medium text-board shadow-[-12px_0_12px_var(--color-board)] hover:bg-amber-soft"
      >
        Ask
      </button>
      {open ? <AssistantPanel tripId={tripId} onClose={close} /> : null}
    </>
  );
}

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
      <NavLink href={`${base}/map`} active={path.startsWith(`${base}/map`)}>
        Map
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
      <NavLink href="/data" active={path.startsWith("/data")}>
        Data
      </NavLink>
      <Presence tripId={tripId} />
      <AskButton tripId={tripId} />
    </>
  );
}
