"use client";

import type { StopView, TravelOptionsResult } from "@trippr/contracts";
import { formatDuration, type TravelOption, type TravelPriority } from "@trippr/rules";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { BusIcon, ModeIcon } from "./icons";

const PRIORITIES: { id: TravelPriority; label: string }[] = [
  { id: "balanced", label: "Best overall" },
  { id: "fastest", label: "Fastest" },
  { id: "cheapest", label: "Cheapest" },
];

function OptionIcon({ option }: { option: TravelOption }) {
  if (option.mode === "car") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ink-soft">
        <path d="M5 17h14M6 17v2M18 17v2M3 13l2-5a2 2 0 0 1 2-1h10a2 2 0 0 1 2 1l2 5v4H3z" />
        <circle cx="7.5" cy="13.5" r="1" />
        <circle cx="16.5" cy="13.5" r="1" />
      </svg>
    );
  }
  if (option.mode === "bus") return <BusIcon className="text-ink-soft" />;
  return <ModeIcon mode={option.mode === "hsr" ? "train" : option.mode} className={option.mode === "flight" ? "text-sky" : "text-rail"} />;
}

/**
 * "Best way here": compares flying, rail, bus and a rental car from the
 * previous stop, with door-to-door time and an estimated cost, and lets an
 * editor apply one to the stop.
 */
export function TravelOptions({
  stop,
  prev,
  travellers,
  canEdit,
  onUse,
}: {
  stop: StopView;
  prev?: StopView;
  travellers: number;
  canEdit: boolean;
  onUse: (option: TravelOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [priority, setPriority] = useState<TravelPriority>("balanced");
  const ready = useAuth().status === "signedIn";
  const from = prev?.city.code;
  const query = useQuery({
    queryKey: ["travel-options", from, stop.city.code, travellers, priority],
    queryFn: () =>
      api<TravelOptionsResult>(`/travel-options?from=${from}&to=${stop.city.code}&travellers=${travellers}&priority=${priority}`),
    enabled: ready && open && Boolean(from) && from !== stop.city.code,
    staleTime: 10 * 60_000,
  });
  if (!prev || prev.city.code === stop.city.code) return null;

  return (
    <div className="text-xs" data-testid="travel-options">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 font-medium text-sky hover:underline"
      >
        {open ? "Hide" : "Best way here"} from {prev.city.name}
      </button>
      {open ? (
        <div className="mt-2 space-y-2 rounded-xl border border-line bg-paper p-2.5">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Rank by">
            {PRIORITIES.map((p) => (
              <button
                key={p.id}
                aria-pressed={priority === p.id}
                onClick={() => setPriority(p.id)}
                className={`rounded-md border px-2 py-0.5 ${priority === p.id ? "border-board bg-board text-amber" : "border-line bg-card hover:border-ink-faint"}`}
              >
                {p.label}
              </button>
            ))}
            {query.data ? <span className="ml-auto text-ink-faint">{query.data.distanceKm.toLocaleString()} km · {travellers} traveller{travellers === 1 ? "" : "s"}</span> : null}
          </div>
          {query.isPending ? <p className="text-ink-faint">Working out the options…</p> : null}
          {query.error ? <p className="text-err">{query.error instanceof Error ? query.error.message : "Couldn't load options"}</p> : null}
          {query.data && query.data.options.length === 0 ? (
            <p className="text-ink-soft">No direct option between these two places. Try the Paths page for connections through other cities.</p>
          ) : null}
          <ul className="space-y-1.5">
            {query.data?.options.map((o) => (
              <li
                key={o.mode}
                className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-1.5 ${o.recommended ? "border border-ok/40 bg-ok/10" : "bg-card"}`}
              >
                <OptionIcon option={o} />
                <span className="font-medium">{o.label}</span>
                {o.recommended ? <span className="rounded-full bg-ok px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-white">Recommended</span> : null}
                <span className="font-mono">{formatDuration(o.minutes)}</span>
                <span className="font-mono">${o.costPerPersonCad} pp</span>
                {o.mode === "car" ? <span className="text-ink-faint">(${o.groupCostCad} for the group)</span> : null}
                <span className={`rounded px-1 text-[10px] uppercase tracking-wide ${o.source === "stored" ? "bg-sky/15 text-sky" : "bg-paper-2 text-ink-faint"}`}>
                  {o.source === "stored" ? "researched" : "estimate"}
                </span>
                {canEdit ? (
                  <button onClick={() => onUse(o)} className="ml-auto font-medium text-sky hover:underline" aria-label={`Use ${o.label} to reach ${stop.city.name}`}>
                    Use
                  </button>
                ) : null}
                <p className="w-full text-[11px] text-ink-soft">{o.note}</p>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-ink-faint">
            Door-to-door times and rough per-person costs in CAD. &ldquo;Researched&rdquo; options come from stored travel links; others are estimates from distance.
          </p>
        </div>
      ) : null}
    </div>
  );
}
