"use client";

import type {
  AddStopBody,
  City,
  Comment,
  CompareResult,
  CreateActivityBody,
  LibraryActivity,
  PatchActivityBody,
  PatchStopBody,
  PathResult,
  RouteView,
  StopLibrary,
  StopView,
  TripDetail,
  TripListItem,
} from "@trippr/contracts";
import { computeBudget, effectiveStopCosts, runChecks, worstLevel } from "@trippr/rules";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, isConflict } from "./api";
import { useToast } from "@/components/toast";
import { useAuth } from "./auth";

/** Queries wait for sign-in so they never fire without a token. */
const useReady = () => useAuth().status === "signedIn";

export const keys = {
  trips: ["trips"] as const,
  trip: (id: string) => ["trip", id] as const,
  route: (id: string) => ["route", id] as const,
  library: (routeId: string) => ["library", routeId] as const,
  tripActivities: (tripId: string) => ["trip-activities", tripId] as const,
  comments: (activityId: string) => ["comments", activityId] as const,
  compare: (a: string, b: string) => ["compare", a, b] as const,
};

export const useTrips = () => {
  const ready = useReady();
  return useQuery({ queryKey: keys.trips, queryFn: () => api<TripListItem[]>("/trips"), enabled: ready });
};

export const useTrip = (id: string) => {
  const ready = useReady();
  return useQuery({ queryKey: keys.trip(id), queryFn: () => api<TripDetail>(`/trips/${id}`), enabled: ready && Boolean(id) });
};

export const useRoute = (id: string) => {
  const ready = useReady();
  return useQuery({ queryKey: keys.route(id), queryFn: () => api<RouteView>(`/routes/${id}`), enabled: ready && Boolean(id) });
};

export const useRouteLibrary = (routeId: string, enabled = true) => {
  const ready = useReady();
  return useQuery({
    queryKey: keys.library(routeId),
    queryFn: () => api<StopLibrary[]>(`/routes/${routeId}/library`),
    enabled: ready && Boolean(routeId) && enabled,
  });
};

export const useTripActivities = (tripId: string) => {
  const ready = useReady();
  return useQuery({
    queryKey: keys.tripActivities(tripId),
    queryFn: () => api<LibraryActivity[]>(`/trips/${tripId}/activities`),
    enabled: ready && Boolean(tripId),
  });
};

export const useComments = (activityId: string, enabled: boolean) => {
  const ready = useReady();
  return useQuery({
    queryKey: keys.comments(activityId),
    queryFn: () => api<Comment[]>(`/activities/${activityId}/comments`),
    enabled: ready && enabled,
  });
};

export const useCompare = (a: string, b: string) => {
  const ready = useReady();
  return useQuery({
    queryKey: keys.compare(a, b),
    queryFn: () => api<CompareResult>(`/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
    enabled: ready && Boolean(a && b && a !== b),
  });
};

export const useCitySearch = (q: string) => {
  const ready = useReady();
  return useQuery({
    queryKey: ["cities", q],
    queryFn: () => api<City[]>(`/cities?q=${encodeURIComponent(q)}&limit=8`),
    staleTime: 5 * 60_000,
    enabled: ready,
  });
};

export const usePath = (params: { from: string; to: string; by: string; railOnly: boolean } | null) => {
  const ready = useReady();
  return useQuery({
    queryKey: ["path", params],
    queryFn: () =>
      api<PathResult>(
        `/paths?from=${params!.from}&to=${params!.to}&by=${params!.by}&railOnly=${params!.railOnly ? "true" : "false"}`,
      ),
    enabled: ready && Boolean(params),
  });
};

/**
 * Recompute dates and checks in the browser with the same rules module the
 * API uses, so optimistic edits show the right dates immediately.
 */
export function recompute(view: RouteView, stops: StopView[]): RouteView {
  const result = runChecks(
    view.trip.startDate,
    stops.map((s) => ({
      id: s.id,
      nights: s.nights,
      cityName: s.city.name,
      countryIso: s.country.iso,
      countryName: s.country.name,
      visaRule: s.country.visaRule ?? null,
      planned: s.planned,
      legs: (s.legs ?? []).map((l) => ({
        id: l.id,
        label: [l.operator, l.number].filter(Boolean).join(" ") || `${l.from.name} → ${l.to.name}`,
        departAt: l.departAt ?? null,
      })),
      view: s,
    })),
  );
  // Chosen hotels and priced legs override the rough estimates, as on the server.
  const budget = computeBudget(
    stops.map((s) => ({ id: s.id, nights: s.nights, planned: s.planned, ...effectiveStopCosts(s) })),
    view.trip.travellers ?? 1,
  );
  // Only the server knows the dates a hotel was booked for, so keep its stay-date checks until it answers.
  const stayChecks = view.checks.checks.filter((c) => c.kind === "stay-dates");
  const checks = [...result.checks, ...stayChecks];
  return {
    ...view,
    stops: result.schedule.stops.map(({ stop, arrive, depart }, i) => ({ ...stop.view, order: i, arrive, depart })),
    budget,
    plannedCostCad: budget.perPerson.activities,
    checks: {
      level: worstLevel(checks.map((c) => c.level)),
      totalNights: result.schedule.totalNights,
      returnDate: result.schedule.returnDate,
      checks,
      visa: result.visa,
      events: result.events,
    },
  };
}

type RouteEdit =
  | { kind: "reorder"; stopIds: string[] }
  | { kind: "addStop"; body: Omit<AddStopBody, "version"> }
  | { kind: "patchStop"; stopId: string; body: Omit<PatchStopBody, "version"> }
  | { kind: "deleteStop"; stopId: string }
  | { kind: "patchRoute"; body: { name?: string; tags?: string[]; isCurrent?: true } };

function optimistic(view: RouteView, edit: RouteEdit): RouteView {
  switch (edit.kind) {
    case "reorder": {
      const byId = new Map(view.stops.map((s) => [s.id, s]));
      return recompute(view, edit.stopIds.map((id) => byId.get(id)!).filter(Boolean));
    }
    case "patchStop":
      return recompute(
        view,
        view.stops.map((s) => (s.id === edit.stopId ? { ...s, ...edit.body } : s)),
      );
    case "deleteStop":
      return recompute(
        view,
        view.stops.filter((s) => s.id !== edit.stopId),
      );
    case "patchRoute":
      return {
        ...view,
        route: {
          ...view.route,
          ...(edit.body.name ? { name: edit.body.name } : {}),
          ...(edit.body.tags ? { tags: edit.body.tags } : {}),
          ...(edit.body.isCurrent ? { isCurrent: true } : {}),
        },
      };
    case "addStop":
      return view; // The new stop needs its city and id from the server.
  }
}

function send(routeId: string, version: number, edit: RouteEdit): Promise<RouteView> {
  switch (edit.kind) {
    case "reorder":
      return api(`/routes/${routeId}/order`, { method: "PUT", body: { stopIds: edit.stopIds, version } });
    case "addStop":
      return api(`/routes/${routeId}/stops`, { method: "POST", body: { ...edit.body, version } });
    case "patchStop":
      return api(`/stops/${edit.stopId}`, { method: "PATCH", body: { ...edit.body, version } });
    case "deleteStop":
      return api(`/stops/${edit.stopId}?version=${version}`, { method: "DELETE" });
    case "patchRoute":
      return api(`/routes/${routeId}`, { method: "PATCH", body: { ...edit.body, version } });
  }
}

function invalidateTrip(qc: QueryClient, view: RouteView | undefined) {
  if (view) void qc.invalidateQueries({ queryKey: keys.trip(view.route.tripId) });
}

/**
 * Every structural edit to a route: applied to the screen at once, sent with
 * the route's version, and rolled back on a 409 or an error. Edits to one
 * route run one after another (mutation scope), each reading the version the
 * previous one returned.
 */
export function useRouteEdit(routeId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    scope: { id: `route-${routeId}` },
    mutationFn: async (edit: RouteEdit) => {
      const current = qc.getQueryData<RouteView>(keys.route(routeId));
      if (!current) throw new Error("Route not loaded");
      return send(routeId, current.route.version, edit);
    },
    onMutate: async (edit) => {
      await qc.cancelQueries({ queryKey: keys.route(routeId) });
      const previous = qc.getQueryData<RouteView>(keys.route(routeId));
      if (previous) qc.setQueryData(keys.route(routeId), optimistic(previous, edit));
      return { previous };
    },
    onError: (error, _edit, context) => {
      if (context?.previous) qc.setQueryData(keys.route(routeId), context.previous);
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
    onSuccess: (view, edit) => {
      qc.setQueryData(keys.route(routeId), view);
      invalidateTrip(qc, view);
      if (edit.kind === "addStop" || edit.kind === "deleteStop") {
        void qc.invalidateQueries({ queryKey: keys.library(routeId) });
      }
    },
  });
}

/** Plan or unplan an activity at a stop (idempotent, so no version). */
export function usePlanToggle(routeId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ stopId, activityId, planned }: { stopId: string; activityId: string; planned: boolean; title: string }) =>
      api<RouteView>(`/stops/${stopId}/plans/${activityId}`, { method: planned ? "PUT" : "DELETE" }),
    onMutate: async ({ stopId, activityId, planned, title }) => {
      await qc.cancelQueries({ queryKey: keys.library(routeId) });
      const previousLib = qc.getQueryData<StopLibrary[]>(keys.library(routeId));
      const previousRoute = qc.getQueryData<RouteView>(keys.route(routeId));
      if (previousLib) {
        qc.setQueryData<StopLibrary[]>(
          keys.library(routeId),
          previousLib.map((l) =>
            l.stopId === stopId
              ? { ...l, activities: l.activities.map((a) => (a.id === activityId ? { ...a, planned } : a)) }
              : l,
          ),
        );
      }
      if (previousRoute) {
        const activity = previousLib?.flatMap((l) => l.activities).find((a) => a.id === activityId);
        qc.setQueryData(
          keys.route(routeId),
          recompute(
            previousRoute,
            previousRoute.stops.map((s) =>
              s.id !== stopId
                ? s
                : {
                    ...s,
                    planned: planned
                      ? [...s.planned, { id: activityId, title, when: activity?.when ?? null, costCad: activity?.costCad ?? null }]
                      : s.planned.filter((p) => p.id !== activityId),
                  },
            ),
          ),
        );
      }
      return { previousLib, previousRoute };
    },
    onError: (error, _v, context) => {
      if (context?.previousLib) qc.setQueryData(keys.library(routeId), context.previousLib);
      if (context?.previousRoute) qc.setQueryData(keys.route(routeId), context.previousRoute);
      toast(error instanceof Error ? error.message : "That didn't save", "error");
    },
    onSuccess: (view) => {
      qc.setQueryData(keys.route(routeId), view);
      invalidateTrip(qc, view);
      void qc.invalidateQueries({ queryKey: keys.tripActivities(view.route.tripId) });
    },
  });
}

/** Vote an activity up or down (or clear), updating every list that shows it. */
export function useVote() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ activityId, value }: { activityId: string; value: -1 | 0 | 1 }) =>
      api<LibraryActivity>(`/activities/${activityId}/vote`, { method: "PUT", body: { value } }),
    onMutate: ({ activityId, value }) => {
      const patch = <T extends { id: string; votes: number; myVote: -1 | 0 | 1 }>(a: T): T =>
        a.id === activityId ? { ...a, votes: a.votes - a.myVote + value, myVote: value } : a;
      qc.setQueriesData<StopLibrary[]>({ queryKey: ["library"] }, (old) =>
        old?.map((l) => ({ ...l, activities: l.activities.map(patch) })),
      );
      qc.setQueriesData<LibraryActivity[]>({ queryKey: ["trip-activities"] }, (old) => old?.map(patch));
    },
    onError: (error) => {
      void qc.invalidateQueries({ queryKey: ["library"] });
      void qc.invalidateQueries({ queryKey: ["trip-activities"] });
      toast(error instanceof Error ? error.message : "Vote failed", "error");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["library"] });
      void qc.invalidateQueries({ queryKey: ["trip-activities"] });
    },
  });
}

export function useCreateActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateActivityBody) => api<LibraryActivity>("/activities", { method: "POST", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["library"] });
      void qc.invalidateQueries({ queryKey: ["trip-activities"] });
    },
  });
}

/** Changes an activity everywhere it appears, so every view of it refetches. */
function invalidateActivityViews(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ["library"] });
  void qc.invalidateQueries({ queryKey: ["trip-activities"] });
  void qc.invalidateQueries({ queryKey: ["route"] });
}

export function useUpdateActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchActivityBody }) =>
      api<LibraryActivity>(`/activities/${id}`, { method: "PATCH", body }),
    onSuccess: () => invalidateActivityViews(qc),
  });
}

export function useDeleteActivity() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/activities/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateActivityViews(qc),
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't delete that activity", "error"),
  });
}

export function useAddComment(activityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => api<Comment[]>(`/activities/${activityId}/comments`, { method: "POST", body: { text } }),
    onSuccess: (comments) => {
      qc.setQueryData(keys.comments(activityId), comments);
      void qc.invalidateQueries({ queryKey: ["library"] });
      void qc.invalidateQueries({ queryKey: ["trip-activities"] });
    },
  });
}
