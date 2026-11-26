"use client";

import { dayDate } from "@trippr/rules";
import { useEffect } from "react";
import type { JourneyStep } from "@/lib/graph";

const MODE: Record<string, string> = { flight: "flight", hsr: "high-speed train", train: "train", maglev: "maglev", boat: "boat", road: "road" };

/** Play, pause and step through a route's legs; drives the 2D highlight and the 3D camera. */
export function JourneyPlayer({
  steps,
  index,
  playing,
  routes,
  routeId,
  onRoute,
  onIndex,
  onPlaying,
}: {
  steps: JourneyStep[];
  index: number;
  playing: boolean;
  routes: { id: string; name: string }[];
  routeId: string | null;
  onRoute(id: string): void;
  onIndex(i: number): void;
  onPlaying(p: boolean): void;
}) {
  useEffect(() => {
    if (!playing) return;
    if (index >= steps.length - 1) {
      onPlaying(false);
      return;
    }
    const t = setTimeout(() => onIndex(index + 1), 1500);
    return () => clearTimeout(t);
  }, [playing, index, steps.length, onIndex, onPlaying]);

  if (steps.length === 0) return null;
  const step = steps[Math.min(index, steps.length - 1)]!;
  const hasLegs = steps.some((s) => s.leg);
  const btn = "grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-board-3 text-amber hover:bg-board-3 disabled:opacity-40";

  return (
    <div className="flex flex-wrap items-center gap-2 bg-board px-3 py-2 text-amber-soft" role="group" aria-label="Journey playback">
      {routes.length > 1 ? (
        <select
          aria-label="Route to play"
          value={routeId ?? ""}
          onChange={(e) => onRoute(e.target.value)}
          className="h-11 rounded-lg border border-board-3 bg-board-2 px-2 text-xs text-amber-soft"
        >
          {routes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      ) : null}
      <button type="button" className={btn} onClick={() => onIndex(Math.max(0, index - 1))} disabled={index === 0} aria-label="Previous stop">
        ‹
      </button>
      <button type="button" className={btn} onClick={() => onPlaying(!playing)} aria-label={playing ? "Pause journey" : "Play journey"} data-testid="journey-play">
        {playing ? "❚❚" : "▶"}
      </button>
      <button type="button" className={btn} onClick={() => onIndex(Math.min(steps.length - 1, index + 1))} disabled={index >= steps.length - 1} aria-label="Next stop">
        ›
      </button>
      <input
        type="range"
        min={0}
        max={steps.length - 1}
        value={index}
        onChange={(e) => onIndex(Number(e.target.value))}
        aria-label="Journey position"
        aria-valuetext={`${step.stop.label}${step.arrive ? `, arriving ${dayDate(step.arrive)}` : ""}`}
        className="h-11 min-w-0 flex-1 accent-accent"
        data-testid="journey-scrubber"
      />
      <span className="min-w-0 basis-full truncate font-mono text-xs sm:basis-auto" aria-live="polite">
        {index + 1}/{steps.length} · {step.stop.label}
        {step.arrive ? ` · ${dayDate(step.arrive)}` : ""}
        {step.leg ? ` · by ${MODE[String(step.leg.style.mode)] ?? step.leg.style.mode}` : ""}
      </span>
      {!hasLegs ? <span className="basis-full text-xs text-amber-soft/70">Add how you get to each stop to see the journey.</span> : null}
    </div>
  );
}
