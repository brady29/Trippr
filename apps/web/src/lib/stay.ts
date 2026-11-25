"use client";

import type { AreaStay, HotelSuggestionsResponse, StayCellsResponse } from "@trippr/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useAuth } from "./auth";
import { bboxParam, type Bbox } from "./stay-cells";

const useReady = () => useAuth().status === "signedIn";

export const stayKeys = {
  area: (areaId: string) => ["stay", "area", areaId] as const,
  suggestions: (areaId: string) => ["stay", "suggestions", areaId] as const,
  cells: (tripId: string, bbox: string) => ["stay", "cells", tripId, bbox] as const,
};

/** The Area's stay card (score parts, explanation, snapshot date, coverage note). */
export function useAreaStay(areaId: string, enabled = true) {
  const ready = useReady();
  return useQuery({
    queryKey: stayKeys.area(areaId),
    queryFn: () => api<AreaStay>(`/areas/${areaId}/stay`),
    enabled: ready && enabled,
    staleTime: 5 * 60_000,
  });
}

/** Open-data hotels inside the Area's radius. Fetched only once the list is opened. */
export function useHotelSuggestions(areaId: string, enabled: boolean) {
  const ready = useReady();
  return useQuery({
    queryKey: stayKeys.suggestions(areaId),
    queryFn: () => api<HotelSuggestionsResponse>(`/areas/${areaId}/hotel-suggestions?limit=30`),
    enabled: ready && enabled,
    staleTime: 5 * 60_000,
  });
}

/** The "Stay prices" layer's cells for a viewport. The previous cells stay on screen while the next ones load. */
export function useStayCells(tripId: string, bbox: Bbox | null, enabled: boolean) {
  const ready = useReady();
  const param = bbox ? bboxParam(bbox) : "";
  return useQuery({
    queryKey: stayKeys.cells(tripId, param),
    queryFn: () => api<StayCellsResponse>(`/trips/${tripId}/stay/cells?bbox=${param}&limit=1500`),
    enabled: ready && enabled && Boolean(bbox),
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });
}
