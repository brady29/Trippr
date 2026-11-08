"use client";

import { usePathname } from "next/navigation";
import { NavLink } from "./shell";

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
      <NavLink href={`${base}/compare`} active={path.startsWith(`${base}/compare`)}>
        Compare
      </NavLink>
      <NavLink href={`${base}/paths`} active={path.startsWith(`${base}/paths`)}>
        Paths
      </NavLink>
    </>
  );
}
