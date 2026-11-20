"use client";

import type { CalendarFeedBody, CalendarFeedLink, CalendarFeedStatus } from "@trippr/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useAuth } from "./auth";

const feedKey = (tripId: string) => ["calendar-feed", tripId] as const;

/** Whether I have a calendar feed for this trip (the link itself is only shown when it's made). */
export function useCalendarFeed(tripId: string, enabled = true) {
  const ready = useAuth().status === "signedIn";
  return useQuery({
    queryKey: feedKey(tripId),
    queryFn: () => api<CalendarFeedStatus>(`/trips/${tripId}/calendar`),
    enabled: ready && enabled && Boolean(tripId),
  });
}

/** Make my link, or a new one (the old one stops working). */
export function useCreateCalendarFeed(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CalendarFeedBody) => api<CalendarFeedLink>(`/trips/${tripId}/calendar`, { method: "POST", body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: feedKey(tripId) }),
  });
}

export function useDeleteCalendarFeed(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>(`/trips/${tripId}/calendar`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: feedKey(tripId) }),
  });
}
