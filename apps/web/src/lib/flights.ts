"use client";

import type { FlightPriceHistory, TripFlightPrices } from "@trippr/contracts";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useAuth } from "./auth";

export const flightKeys = {
  trip: (tripId: string) => ["flight-prices", "trip", tripId] as const,
  leg: (legId: string) => ["flight-prices", "leg", legId] as const,
};

/**
 * The current route's flights with latest price, signal and price-drop notices.
 * `enabled: false` in the answer means the feature is off, so the UI hides it.
 * Prices change once a day, so this refreshes when the tab regains focus, not constantly.
 */
export function useTripFlightPrices(tripId: string | undefined) {
  const ready = useAuth().status === "signedIn";
  return useQuery({
    queryKey: flightKeys.trip(tripId ?? ""),
    queryFn: () => api<TripFlightPrices>(`/trips/${tripId}/flight-prices`),
    enabled: ready && Boolean(tripId),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useLegFlightPrices(legId: string, enabled: boolean) {
  const ready = useAuth().status === "signedIn";
  return useQuery({
    queryKey: flightKeys.leg(legId),
    queryFn: () => api<FlightPriceHistory>(`/legs/${legId}/flight-prices`),
    enabled: ready && enabled,
    staleTime: 5 * 60_000,
  });
}

export const cad = (n: number | null | undefined) => (n == null ? "no price" : `$${Math.round(n).toLocaleString("en-CA")}`);
