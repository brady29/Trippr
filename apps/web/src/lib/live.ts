"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_URL, authHeaders } from "./api";
import { useAuth } from "./auth";
import { keys } from "./queries";

export interface Present {
  id: string;
  name: string;
}

type Change = ({ kind: "route"; routeId: string } | { kind: "trip" } | { kind: "activities" } | { kind: "members" }) & {
  by: string;
};

/** Stop listening after this long without any interaction, so idle tabs don't keep the API busy. */
const IDLE_MS = 15 * 60_000;

/**
 * Listens to the trip's server-sent events while the tab is visible and in
 * use. Other people's changes refetch the affected queries; your own are
 * already applied optimistically, so they are ignored.
 */
export function useTripLive(tripId: string | undefined): { present: Present[]; connected: boolean } {
  const { status, me } = useAuth();
  const qc = useQueryClient();
  const [present, setPresent] = useState<Present[]>([]);
  const [connected, setConnected] = useState(false);
  const myId = me?.id;

  useEffect(() => {
    if (!tripId || status !== "signedIn") return;
    let controller: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let backoff = 2000;
    let stopped = false;

    const onChange = (change: Change) => {
      if (change.by === myId) return;
      switch (change.kind) {
        case "route":
          void qc.invalidateQueries({ queryKey: keys.route(change.routeId) });
          void qc.invalidateQueries({ queryKey: keys.library(change.routeId) });
          void qc.invalidateQueries({ queryKey: keys.trip(tripId) });
          void qc.invalidateQueries({ queryKey: ["compare"] });
          void qc.invalidateQueries({ queryKey: ["bookings"] });
          break;
        case "trip":
        case "members":
          void qc.invalidateQueries({ queryKey: keys.trip(tripId) });
          void qc.invalidateQueries({ queryKey: ["route"] });
          break;
        case "activities":
          void qc.invalidateQueries({ queryKey: ["library"] });
          void qc.invalidateQueries({ queryKey: ["trip-activities"] });
          void qc.invalidateQueries({ queryKey: ["route"] });
          break;
      }
    };

    const connect = async () => {
      if (stopped || controller || document.visibilityState !== "visible") return;
      controller = new AbortController();
      try {
        const res = await fetch(`${API_URL}/trips/${tripId}/live`, {
          headers: await authHeaders(),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`live ${res.status}`);
        setConnected(true);
        backoff = 2000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (!event || !data) continue;
            if (event === "presence") setPresent(JSON.parse(data) as Present[]);
            if (event === "change") onChange(JSON.parse(data) as Change);
          }
        }
      } catch {
        /* aborted or network error: reconnect below */
      }
      controller = null;
      setConnected(false);
      setPresent([]);
      if (!stopped && document.visibilityState === "visible") {
        retry = setTimeout(() => void connect(), backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    };

    const disconnect = () => {
      clearTimeout(retry);
      controller?.abort();
    };

    const onActivity = () => {
      clearTimeout(idle);
      idle = setTimeout(disconnect, IDLE_MS);
      if (!controller) {
        // Catch up on anything missed while idle or hidden, then listen again.
        void qc.invalidateQueries({ queryKey: keys.trip(tripId) });
        void qc.invalidateQueries({ queryKey: ["route"] });
        void connect();
      }
    };

    const onVisibility = () => (document.visibilityState === "visible" ? onActivity() : disconnect());
    const activityEvents = ["pointerdown", "keydown", "scroll", "touchstart"] as const;

    void connect();
    idle = setTimeout(disconnect, IDLE_MS);
    document.addEventListener("visibilitychange", onVisibility);
    for (const e of activityEvents) window.addEventListener(e, onActivity, { passive: true });

    return () => {
      stopped = true;
      disconnect();
      clearTimeout(idle);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const e of activityEvents) window.removeEventListener(e, onActivity);
    };
  }, [tripId, status, myId, qc]);

  return { present, connected };
}
