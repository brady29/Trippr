"use client";

import type { StopView } from "@trippr/contracts";
import { octilinearPath, roundedPath, schematicLayout, type Station } from "@trippr/rules";
import { useMemo, useState } from "react";

type Line = { stops: StopView[]; color: string; name?: string };

const MODE_STYLE: Record<string, { dash?: string; width: number; color?: string }> = {
  flight: { dash: "2 7", width: 3.5, color: "var(--color-sky)" },
  hsr: { width: 6 },
  train: { width: 5 },
  maglev: { width: 6 },
  road: { dash: "1 5", width: 3.5, color: "var(--color-ink-soft)" },
  boat: { dash: "8 5", width: 3.5, color: "var(--color-sky)" },
};

const minutes = (m?: number | null) => (m ? (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, "0") : ""}` : `${m}m`) : null);

/** How a stop is reached: its last ticket's mode, else the planned mode. */
const modeOf = (s: StopView) => s.legs.at(-1)?.mode ?? s.arriveMode;
const minutesOf = (s: StopView) => s.legs.reduce((n, l) => n + (l.durationMin ?? 0), 0) || null;

/**
 * A rail-network diagram of one or two routes. Stations keep roughly their
 * real places but lines only run straight or at 45°; the same city is the
 * same station on both routes. Rail is solid, flights dotted.
 */
export function LineMap({
  lines,
  ghost,
  width = 340,
  height = 420,
  pinned = new Set<string>(),
  onStation,
  playKey,
  label = "Line map",
}: {
  lines: Line[];
  /** A previous order drawn faintly underneath (for "Suggest a better order"). */
  ghost?: StopView[];
  width?: number;
  height?: number;
  /** Stop ids with a booked date, marked on their station. */
  pinned?: Set<string>;
  onStation?: (stopId: string) => void;
  /** Changing this replays the train running along the first line. */
  playKey?: string | number;
  label?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const all = useMemo(() => [...lines.flatMap((l) => l.stops), ...(ghost ?? [])], [lines, ghost]);
  const stations = useMemo(() => {
    const layout = schematicLayout(
      all.map((s) => ({ id: s.city.code, lat: s.city.lat, lon: s.city.lon, name: s.city.name })),
      { width, height },
    );
    return new Map<string, Station>(layout.map((s) => [s.id, s]));
  }, [all, width, height]);
  const shared = useMemo(() => {
    if (lines.length < 2) return new Set<string>();
    const [a, b] = lines;
    const inB = new Set(b!.stops.map((s) => s.city.code));
    return new Set(a!.stops.map((s) => s.city.code).filter((c) => inB.has(c)));
  }, [lines]);

  const pathFor = (stops: StopView[]) => {
    const pts = stops.map((s) => stations.get(s.city.code)!).filter(Boolean);
    const out: { x: number; y: number }[] = [];
    pts.forEach((p, i) => {
      if (i === 0) out.push(p);
      else out.push(...octilinearPath(pts[i - 1]!, p).slice(1));
    });
    return out;
  };

  const firstLine = lines[0];
  const trainPath = firstLine ? roundedPath(pathFor(firstLine.stops), 12) : "";
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="group"
      aria-label={`${label}: ${lines.map((l) => `${l.name ? `${l.name}, ` : ""}${l.stops.map((s) => s.city.name).join(", ")}`).join("; ")}`}
      data-testid="line-map"
    >
      {/* A faint grid, like the drafting sheet the line was drawn on. */}
      <defs>
        <pattern id="lm-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M24 0H0V24" fill="none" stroke="var(--color-line)" strokeWidth="0.5" opacity="0.6" />
        </pattern>
      </defs>
      <rect width={width} height={height} fill="url(#lm-grid)" opacity="0.5" />

      {ghost ? <path d={roundedPath(pathFor(ghost), 12)} fill="none" stroke="var(--color-ink-faint)" strokeWidth="4" strokeDasharray="3 6" opacity="0.7" data-testid="line-ghost" /> : null}

      {/* Lines: each segment styled by how you travel it. Later lines underneath, so the first sits on top. */}
      {[...lines].reverse().map((line, li) => {
        const idx = lines.length - 1 - li;
        return line.stops.slice(1).map((s, i) => {
          const from = stations.get(line.stops[i]!.city.code);
          const to = stations.get(s.city.code);
          if (!from || !to) return null;
          const style = MODE_STYLE[modeOf(s)] ?? MODE_STYLE.train!;
          const pts = octilinearPath(from, to);
          const mid = pts[Math.floor(pts.length / 2)]!;
          const mins = idx === 0 ? minutes(minutesOf(s)) : null;
          return (
            <g key={`${idx}-${s.id}`}>
              <path
                d={roundedPath(pts, 12)}
                fill="none"
                stroke={lines.length > 1 ? line.color : (style.color ?? line.color)}
                strokeWidth={lines.length > 1 && idx > 0 ? style.width + 4 : style.width}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={style.dash}
                className="line-draw"
                style={{ animationDelay: `${i * 70}ms` }}
              />
              {mins ? (
                <text x={mid.x + 6} y={mid.y - 6} className="fill-ink-soft font-mono text-[9px]">
                  {mins}
                </text>
              ) : null}
            </g>
          );
        });
      })}

      {/* The train, once along the first line when it changes or on Play. */}
      {trainPath && !reduce ? (
        <circle key={String(playKey)} r="5" fill="var(--color-accent)" stroke="var(--color-card)" strokeWidth="2">
          <animateMotion dur={`${Math.max(2.5, (firstLine?.stops.length ?? 1) * 0.45)}s`} repeatCount="1" fill="freeze" path={trainPath} />
        </circle>
      ) : null}

      {/* Stations. */}
      {[...new Map(all.map((s) => [s.city.code, s])).values()].map((s) => {
        const st = stations.get(s.city.code);
        if (!st) return null;
        const onLine = lines.some((l) => l.stops.some((x) => x.city.code === s.city.code));
        const isShared = shared.has(s.city.code);
        const isStart = firstLine?.stops[0]?.city.code === s.city.code;
        const nights = firstLine?.stops.filter((x) => x.city.code === s.city.code).reduce((n, x) => n + x.nights, 0);
        const active = hover === s.city.code;
        const stopId = firstLine?.stops.find((x) => x.city.code === s.city.code)?.id ?? s.id;
        return (
          <g
            key={s.city.code}
            tabIndex={onLine ? 0 : -1}
            role="img"
            aria-label={`${s.city.name}${nights ? `, ${nights} night${nights === 1 ? "" : "s"}` : ""}${isShared ? ", on both routes" : ""}${pinned.has(stopId) ? ", booked" : ""}`}
            onMouseEnter={() => setHover(s.city.code)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(s.city.code)}
            onBlur={() => setHover(null)}
            onClick={() => onStation?.(stopId)}
            onKeyDown={(e) => e.key === "Enter" && onStation?.(stopId)}
            className={`outline-none ${onStation ? "cursor-pointer" : ""}`}
            opacity={onLine ? 1 : 0.45}
            data-testid="line-station"
            data-city={s.city.code}
          >
            {isShared ? (
              <rect x={st.x - 9} y={st.y - 6} width="18" height="12" rx="6" fill="var(--color-card)" stroke="var(--color-ink)" strokeWidth="2.5" />
            ) : (
              <circle cx={st.x} cy={st.y} r={isStart ? 7 : 5.5} fill="var(--color-card)" stroke={active ? "var(--color-accent)" : "var(--color-ink)"} strokeWidth={isStart ? 3.5 : 2.5} />
            )}
            {isStart ? <circle cx={st.x} cy={st.y} r="2.5" fill="var(--color-ink)" /> : null}
            {pinned.has(stopId) ? <circle cx={st.x + 6} cy={st.y - 6} r="3.5" fill="var(--color-ok)" stroke="var(--color-card)" strokeWidth="1.5" /> : null}
            <text
              x={st.label === "right" ? st.x + 11 : st.label === "left" ? st.x - 11 : st.x}
              y={st.label === "above" ? st.y - 12 : st.label === "below" ? st.y + 20 : st.y + 3.5}
              textAnchor={st.label === "right" ? "start" : st.label === "left" ? "end" : "middle"}
              className={`text-[11px] ${active ? "fill-accent font-semibold" : "fill-ink font-medium"}`}
              style={{ paintOrder: "stroke", stroke: "var(--color-card)", strokeWidth: 3, strokeLinejoin: "round" }}
            >
              {s.city.name}
              {nights ? <tspan className="fill-ink-faint font-mono text-[9px]"> {nights}n</tspan> : null}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
