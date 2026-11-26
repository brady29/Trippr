"use client";

import { useMutationState } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

const subscribe = (on: () => void) => {
  window.addEventListener("online", on);
  window.addEventListener("offline", on);
  return () => {
    window.removeEventListener("online", on);
    window.removeEventListener("offline", on);
  };
};

/** Whether the browser thinks it's online (true on the server). */
export function useOnline() {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
}

/**
 * Planning often happens on hotel or café Wi-Fi. When the connection drops,
 * say so, and say how many changes are waiting: they save on their own when
 * it's back (mutations pause while offline and retry network failures).
 */
export function OfflineBanner() {
  const online = useOnline();
  const waiting = useMutationState({ filters: { status: "pending" }, select: (m) => m.state.isPaused }).filter(Boolean).length;
  if (online && !waiting) return null;
  return (
    <div className="sticky top-0 z-30 flex items-center justify-center gap-2 bg-warn px-4 py-1.5 text-center text-xs font-medium text-white" role="status" aria-live="polite" data-testid="offline-banner">
      {online
        ? `Reconnecting… ${waiting} change${waiting === 1 ? "" : "s"} waiting to save.`
        : `You're offline. ${waiting ? `${waiting} change${waiting === 1 ? "" : "s"} will save` : "Changes you make will save"} when the connection is back.`}
    </div>
  );
}

/** A grey block the shape of content that's on its way. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-paper-2 ${className}`} aria-hidden />;
}

/** The route editor while it loads: a board, a strip, and stop cards. */
export function RouteSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the route" data-testid="route-skeleton">
      <div className="bg-board px-4 py-4 sm:px-6">
        <div className="mx-auto max-w-6xl space-y-3">
          <div className="h-3 w-40 animate-pulse rounded bg-board-3" />
          <div className="h-7 w-56 animate-pulse rounded bg-board-3" />
          <div className="h-9 w-full animate-pulse rounded bg-board-3" />
        </div>
      </div>
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
        <div className="space-y-4">
          <Skeleton className="h-56" />
          <Skeleton className="h-40" />
        </div>
      </div>
    </div>
  );
}
