"use client";

import type { ActivityPage } from "@trippr/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { TAG_COLOR, TAG_LABEL } from "@/lib/graph-palette";
import { consensusHighlights, consensusPoints, tasteProfile, type ConsensusPoint } from "@/lib/taste";
import { Spinner } from "./ui";

/** A stable small offset per idea so bubbles with the same score don't sit exactly on top of each other. */
function jitter(id: string, spread: number) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return ((((h % 1000) + 1000) % 1000) / 1000 - 0.5) * spread;
}

const W = 360;
const H = 250;
const PAD = 28;

/** Each idea the group voted on: across, how much they like it; up, how much they agree. */
function ConsensusChart({ points }: { points: ConsensusPoint[] }) {
  const [focus, setFocus] = useState<ConsensusPoint | null>(null);
  const x = (liking: number) => PAD + ((liking + 1) / 2) * (W - PAD * 2);
  const y = (agreement: number) => H - PAD - agreement * (H - PAD * 2);
  return (
    <figure className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="group" aria-label="Where the group agrees" data-testid="consensus-chart">
        <rect x={x(0.2)} y={y(1)} width={x(1) - x(0.2)} height={y(0.7) - y(1)} rx="10" fill="var(--color-ok)" opacity="0.08" />
        <rect x={x(-1)} y={y(1)} width={x(-0.2) - x(-1)} height={y(0.7) - y(1)} rx="10" fill="var(--color-err)" opacity="0.07" />
        <rect x={x(-0.6)} y={y(0.45)} width={x(0.6) - x(-0.6)} height={y(0) - y(0.45)} rx="10" fill="var(--color-mark)" opacity="0.12" />
        <text x={x(1) - 6} y={y(1) + 14} textAnchor="end" className="fill-ok text-[10px] font-semibold uppercase tracking-[0.14em]">
          Everyone loves
        </text>
        <text x={x(-1) + 6} y={y(1) + 14} className="fill-err text-[10px] font-semibold uppercase tracking-[0.14em]">
          Everyone passes
        </text>
        <text x={W / 2} y={y(0) - 8} textAnchor="middle" className="fill-ink-soft text-[10px] font-semibold uppercase tracking-[0.14em]">
          Splits the group
        </text>
        <line x1={x(0)} x2={x(0)} y1={y(1)} y2={y(0)} stroke="var(--color-line)" strokeDasharray="3 4" />
        <text x={x(-1)} y={H - 8} className="fill-ink-faint text-[10px]">
          No
        </text>
        <text x={x(1)} y={H - 8} textAnchor="end" className="fill-ink-faint text-[10px]">
          Yes
        </text>
        {points.map((p, i) => {
          const r = 4 + 3 * Math.sqrt(p.yes + p.no);
          const cx = Math.max(PAD, Math.min(W - PAD, x(p.liking) + jitter(p.id, 16)));
          const cy = Math.max(PAD, Math.min(H - PAD, y(p.agreement) + jitter(p.id + "y", 14)));
          return (
            <g
              key={p.id}
              tabIndex={0}
              role="img"
              aria-label={`${p.title} in ${p.cityName}: ${p.yes} yes, ${p.no} no`}
              onMouseEnter={() => setFocus(p)}
              onFocus={() => setFocus(p)}
              onMouseLeave={() => setFocus(null)}
              onBlur={() => setFocus(null)}
              className="taste-bubble cursor-default outline-none"
              style={{ animationDelay: `${Math.min(i, 40) * 18}ms` }}
            >
              <circle cx={cx} cy={cy} r={r} fill={TAG_COLOR[p.tag]} fillOpacity={focus?.id === p.id ? 1 : 0.72} stroke="var(--color-card)" strokeWidth="1.5" />
              {focus?.id === p.id ? <circle cx={cx} cy={cy} r={r + 4} fill="none" stroke="var(--color-ink)" strokeWidth="1.5" /> : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="min-h-[2.5rem] text-xs text-ink-soft" aria-live="polite">
        {focus ? (
          <>
            <span className="font-semibold text-ink">{focus.title}</span> · {focus.cityName} · {focus.yes} yes, {focus.no} no
          </>
        ) : (
          "Each bubble is an idea; bigger means more votes. Point at one, or tab through them."
        )}
      </figcaption>
    </figure>
  );
}

const R = 78;

/** What you say yes to, over what the group says yes to, by kind of idea. */
function TasteRadar({ axes }: { axes: ReturnType<typeof tasteProfile> }) {
  const max = Math.max(0.0001, ...axes.flatMap((a) => [a.you, a.group]));
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / axes.length;
  const pt = (i: number, v: number) => [110 + Math.cos(angle(i)) * R * (v / max), 100 + Math.sin(angle(i)) * R * (v / max)] as const;
  const poly = (key: "you" | "group") => axes.map((a, i) => pt(i, a[key]).join(",")).join(" ");
  const anyMine = axes.some((a) => a.you > 0);
  return (
    <figure className="flex flex-wrap items-center gap-4">
      <svg viewBox="0 0 220 200" className="w-56 max-w-full" role="img" aria-label={`Your taste next to the group's: ${axes.map((a) => `${TAG_LABEL[a.tag]} ${Math.round(a.you * 100)}% for you, ${Math.round(a.group * 100)}% for the group`).join("; ")}`} data-testid="taste-radar">
        {[0.33, 0.66, 1].map((f) => (
          <polygon key={f} points={axes.map((_, i) => pt(i, max * f).join(",")).join(" ")} fill="none" stroke="var(--color-line)" />
        ))}
        {axes.map((a, i) => {
          const [lx, ly] = pt(i, max * 1.22);
          const [ex, ey] = pt(i, max);
          return (
            <g key={a.tag}>
              <line x1="110" y1="100" x2={ex} y2={ey} stroke="var(--color-line)" />
              <text x={lx} y={ly + 3} textAnchor="middle" className="fill-ink-soft text-[10px] font-medium">
                {TAG_LABEL[a.tag]}
              </text>
            </g>
          );
        })}
        <polygon points={poly("group")} fill="var(--color-mark)" fillOpacity="0.28" stroke="var(--color-mark)" strokeWidth="1.5" className="taste-shape" />
        {anyMine ? <polygon points={poly("you")} fill="var(--color-accent)" fillOpacity="0.12" stroke="var(--color-accent)" strokeWidth="2" className="taste-shape" /> : null}
      </svg>
      <figcaption className="space-y-1.5 text-xs text-ink-soft">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-4 rounded-sm border-2 border-accent" /> You
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-mark/60" /> The group
        </div>
        {!anyMine ? <p className="max-w-[12rem]">Say yes to a few ideas to see your own shape.</p> : null}
      </figcaption>
    </figure>
  );
}

export function GroupTaste({ tripId }: { tripId: string }) {
  const ready = useAuth().status === "signedIn";
  // Under the activities prefix, so every vote refreshes it.
  const q = useQuery({
    queryKey: ["trip-activities", tripId, "taste"],
    queryFn: () => api<ActivityPage>(`/trips/${tripId}/activities/page?scope=mine&limit=100`),
    enabled: ready,
  });
  const items = q.data?.items;
  const points = useMemo(() => consensusPoints(items ?? []), [items]);
  const axes = useMemo(() => tasteProfile(items ?? []), [items]);
  const { loved, split } = useMemo(() => consensusHighlights(points), [points]);

  return (
    <div className="space-y-5 rounded-2xl border border-line bg-card p-4 sm:p-5" data-testid="group-taste">
      <div>
        <h2 className="text-sm font-semibold">Where the group agrees</h2>
        <p className="text-xs text-ink-soft">From everyone&apos;s yes and no counts. Nobody&apos;s individual votes are shown.</p>
      </div>
      {q.isPending ? <Spinner label="Counting votes" /> : null}
      {points.length ? (
        <ConsensusChart points={points} />
      ) : !q.isPending ? (
        <p className="rounded-xl bg-paper px-3 py-6 text-center text-sm text-ink-soft">No votes yet. Swipe a few ideas and the chart fills in.</p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ok">Everyone loves</h3>
          <ol className="space-y-1 text-sm" data-testid="loved">
            {loved.slice(0, 5).map((p) => (
              <li key={p.id} className="flex justify-between gap-2">
                <span className="truncate">{p.title}</span>
                <span className="shrink-0 font-mono text-xs text-ink-soft">{p.yes} yes</span>
              </li>
            ))}
            {!loved.length ? <li className="text-xs text-ink-faint">Nothing unanimous yet.</li> : null}
          </ol>
        </div>
        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-warn">Splits the group</h3>
          <ol className="space-y-1 text-sm" data-testid="split">
            {split.slice(0, 5).map((p) => (
              <li key={p.id} className="flex justify-between gap-2">
                <span className="truncate">{p.title}</span>
                <span className="shrink-0 font-mono text-xs text-ink-soft">
                  {p.yes}–{p.no}
                </span>
              </li>
            ))}
            {!split.length ? <li className="text-xs text-ink-faint">No disagreements so far.</li> : null}
          </ol>
        </div>
      </div>
      <div>
        <h2 className="mb-2 text-sm font-semibold">Your taste and the group&apos;s</h2>
        <TasteRadar axes={axes} />
      </div>
    </div>
  );
}
