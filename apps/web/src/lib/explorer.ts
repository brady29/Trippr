"use client";

import type {
  Area,
  CreateAreaBody,
  CreateHotelBody,
  CreateLegBody,
  Hotel,
  Hub,
  HubKind,
  LegPrivate,
  PatchHotelBody,
  PatchLegBody,
  RouteView,
  StayStatus,
} from "@trippr/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/toast";
import { api, isConflict } from "./api";
import { useAuth } from "./auth";
import { keys } from "./queries";

const useReady = () => useAuth().status === "signedIn";

export const explorerKeys = {
  hubs: (q: string, city?: string, kind?: HubKind) => ["hubs", q, city ?? "", kind ?? ""] as const,
  areas: (tripId: string, city: string) => ["areas", tripId, city] as const,
  hotels: (tripId: string, city: string) => ["hotels", tripId, city] as const,
  legPrivate: (legId: string) => ["leg-private", legId] as const,
};

export function useHubSearch(q: string, city?: string, kind?: HubKind) {
  const ready = useReady();
  return useQuery({
    queryKey: explorerKeys.hubs(q, city, kind),
    queryFn: () => {
      const params = new URLSearchParams({ q, limit: "10" });
      if (city) params.set("city", city);
      if (kind) params.set("kind", kind);
      return api<Hub[]>(`/hubs?${params}`);
    },
    enabled: ready,
    staleTime: 10 * 60_000,
  });
}

export function useAreas(tripId: string, city: string, enabled = true) {
  const ready = useReady();
  return useQuery({
    queryKey: explorerKeys.areas(tripId, city),
    queryFn: () => api<Area[]>(`/cities/${city}/areas?tripId=${encodeURIComponent(tripId)}`),
    enabled: ready && enabled,
  });
}

export function useHotels(tripId: string, city: string, enabled = true) {
  const ready = useReady();
  return useQuery({
    queryKey: explorerKeys.hotels(tripId, city),
    queryFn: () => api<Hotel[]>(`/trips/${tripId}/hotels?city=${city}`),
    enabled: ready && enabled,
  });
}

export function useLegPrivate(legId: string, enabled: boolean) {
  const ready = useReady();
  return useQuery({
    queryKey: explorerKeys.legPrivate(legId),
    queryFn: () => api<LegPrivate>(`/legs/${legId}/private`),
    enabled: ready && enabled,
  });
}

type RouteWrite =
  | { kind: "addLeg"; stopId: string; body: Omit<CreateLegBody, "version"> }
  | { kind: "patchLeg"; legId: string; body: Omit<PatchLegBody, "version"> }
  | { kind: "deleteLeg"; legId: string }
  | { kind: "setStay"; stopId: string; hotelId: string; status: StayStatus; rooms?: number | null }
  | { kind: "removeStay"; stopId: string; hotelId: string };

function sendWrite(version: number, w: RouteWrite): Promise<RouteView> {
  switch (w.kind) {
    case "addLeg":
      return api(`/stops/${w.stopId}/legs`, { method: "POST", body: { ...w.body, version } });
    case "patchLeg":
      return api(`/legs/${w.legId}`, { method: "PATCH", body: { ...w.body, version } });
    case "deleteLeg":
      return api(`/legs/${w.legId}?version=${version}`, { method: "DELETE" });
    case "setStay":
      return api(`/stops/${w.stopId}/stays/${w.hotelId}`, {
        method: "PUT",
        body: { status: w.status, ...(w.rooms != null ? { rooms: w.rooms } : {}), version },
      });
    case "removeStay":
      return api(`/stops/${w.stopId}/stays/${w.hotelId}?version=${version}`, { method: "DELETE" });
  }
}

/**
 * Legs and stays change the route's structure, so they share the route's
 * edit queue (mutation scope) and send the version the last write returned.
 */
export function useRouteWrite(routeId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    scope: { id: `route-${routeId}` },
    mutationFn: async (w: RouteWrite) => {
      const current = qc.getQueryData<RouteView>(keys.route(routeId));
      if (!current) throw new Error("Route not loaded");
      return sendWrite(current.route.version, w);
    },
    onSuccess: (view, w) => {
      qc.setQueryData(keys.route(routeId), view);
      void qc.invalidateQueries({ queryKey: keys.trip(view.route.tripId) });
      void qc.invalidateQueries({ queryKey: ["graph"] });
      if (w.kind === "setStay" || w.kind === "removeStay") void qc.invalidateQueries({ queryKey: ["hotels"] });
    },
    onError: (error) => {
      void qc.invalidateQueries({ queryKey: keys.route(routeId) });
      toast(
        isConflict(error)
          ? "Someone else just changed this route. Showing the latest version; try again."
          : error instanceof Error
            ? error.message
            : "That didn't save",
        "error",
      );
    },
  });
}

export function useCreateArea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAreaBody) => api<Area>("/areas", { method: "POST", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["areas"] });
      void qc.invalidateQueries({ queryKey: ["graph"] });
    },
  });
}

export function useCreateHotel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateHotelBody) => api<Hotel>("/hotels", { method: "POST", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["hotels"] });
      void qc.invalidateQueries({ queryKey: ["areas"] });
      void qc.invalidateQueries({ queryKey: ["graph"] });
    },
  });
}

export function useUpdateHotel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchHotelBody }) => api<Hotel>(`/hotels/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["hotels"] });
      void qc.invalidateQueries({ queryKey: ["route"] });
      void qc.invalidateQueries({ queryKey: ["graph"] });
    },
  });
}

export function useDeleteHotel() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/hotels/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["hotels"] });
      void qc.invalidateQueries({ queryKey: ["route"] });
      void qc.invalidateQueries({ queryKey: ["graph"] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Couldn't delete that hotel", "error"),
  });
}

export function useVoteOn(kind: "hotels" | "areas") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, value }: { id: string; value: -1 | 0 | 1 }) => api(`/${kind}/${id}/vote`, { method: "PUT", body: { value } }),
    onSettled: () => void qc.invalidateQueries({ queryKey: [kind] }),
  });
}

/**
 * Default UTC offsets for May–June 2027, by city code, for the leg time
 * fields. Editable in the form; they only pre-fill the offset.
 */
const OFFSETS: Record<string, string> = {
  TYO: "+09:00", OSA: "+09:00", UKY: "+09:00", HIJ: "+09:00", SPK: "+09:00", FUK: "+09:00",
  SEL: "+09:00", PUS: "+09:00",
  BJS: "+08:00", SIA: "+08:00", CKG: "+08:00", CTU: "+08:00", CAN: "+08:00", SZX: "+08:00", SHA: "+08:00",
  KWL: "+08:00", DYG: "+08:00", HGH: "+08:00", HKG: "+08:00", MFM: "+08:00", TPE: "+08:00",
  KUL: "+08:00", SIN: "+08:00", MNL: "+08:00", ENI: "+08:00", DPS: "+08:00", LBJ: "+08:00", KOM: "+08:00",
  HAN: "+07:00", VDO: "+07:00", DAD: "+07:00", SGN: "+07:00", BKK: "+07:00", CNX: "+07:00", HKT: "+07:00",
  REP: "+07:00", PNH: "+07:00", LPQ: "+07:00", VTE: "+07:00", JKT: "+07:00", JOG: "+07:00",
  YTO: "-04:00",
};
export const OFFSET_CHOICES = ["-04:00", "+00:00", "+07:00", "+08:00", "+09:00"];
export const defaultOffset = (cityCode?: string) => (cityCode && OFFSETS[cityCode]) || "+08:00";

/** "2027-05-19T08:05+08:00" → { local: "2027-05-19T08:05", offset: "+08:00" } */
export function splitDateTime(value?: string | null): { local: string; offset: string | null } {
  if (!value) return { local: "", offset: null };
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return { local: "", offset: null };
  return { local: m[1]!, offset: m[2] === "Z" ? "+00:00" : m[2]! };
}

export const joinDateTime = (local: string, offset: string) => (local ? `${local}${offset}` : null);

export function formatLegTime(value?: string | null): string {
  const { local } = splitDateTime(value);
  if (!local) return "";
  const [date, time] = local.split("T");
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return `${day} ${time}`;
}
