"use client";

import { hasRole, type ActivityPage, type LibraryActivity, type RouteView } from "@trippr/contracts";
import { isFixedDate, shortDate, whenLabel } from "@trippr/rules";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GroupTaste } from "@/components/group-taste";
import { DownIcon, StarIcon, ThumbDownIcon, ThumbUpIcon, UndoIcon, UpIcon } from "@/components/icons";
import { BoardHeader, BoardStat, Flaps, RequireAuth } from "@/components/shell";
import { Button, ErrorNote, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { usePlanToggle, useRoute, useTrip, useVote } from "@/lib/queries";

type Dir = "yes" | "no" | "must" | "skip";
interface Done {
  card: LibraryActivity;
  dir: Dir;
  /** The stop it was planned at by "must do", to undo. */
  plannedAt?: string;
}

/** Card surface (not .ticket, whose position: relative would beat the absolute stacking). */
const CARD = "absolute inset-0 rounded-2xl border border-line bg-card shadow-[0_1px_0_rgb(21_23_26/0.04),0_14px_30px_-18px_rgb(21_23_26/0.45)]";

const DIR_VALUE: Record<Dir, -1 | 0 | 1> = { yes: 1, must: 1, no: -1, skip: 0 };
const PRICE: Record<string, string> = { free: "Free", $: "$", $$: "$$", $$$: "$$$" };
const BEST: Record<string, string> = { morning: "Best in the morning", afternoon: "Best in the afternoon", evening: "Best in the evening", night: "Best at night", any: "Good any time" };

/** Fetches the next ideas this member hasn't voted on in one city, leaving out ones already on screen this session. */
async function fetchDeck(tripId: string, city: string | null, seen: Set<string>): Promise<LibraryActivity[]> {
  const qs = new URLSearchParams({ unvoted: "true", limit: "40", sort: "relevance" });
  if (city) qs.set("city", city);
  const page = await api<ActivityPage>(`/trips/${tripId}/activities/page?${qs}`);
  return page.items.filter((a) => !seen.has(a.id));
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-paper-2 px-2.5 py-0.5 text-xs text-ink-soft">{children}</span>;
}

/** One idea as a postcard: the city on the board, what it is, and what the group thinks so far. */
function Card({ a, stamp }: { a: LibraryActivity; stamp?: string }) {
  const e = a.enrichment;
  const yes = a.ups ?? Math.max(0, a.votes);
  const no = a.downs ?? 0;
  return (
    <div className="flex h-full flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-lg" aria-hidden>
          <Flaps text={a.cityCode} />
        </span>
        <span className="text-right text-xs text-ink-faint">
          {a.cityName}
          {a.category ? <span className="block capitalize">{a.category.replace(/_/g, " ")}</span> : null}
        </span>
      </div>
      <h2 className="text-2xl font-semibold leading-tight text-balance">{a.title}</h2>
      {isFixedDate(a.when) ? (
        <p className="inline-flex items-center gap-1.5 text-sm text-stamp">
          <StarIcon className="h-4 w-4" /> {whenLabel(a.when)}
        </p>
      ) : null}
      {e?.summary ? (
        <p className="text-[15px] leading-relaxed text-ink-soft">
          {e.summary}
          {e.summaryAi && e.aiLabel ? <span className="mt-1 block text-[11px] text-ink-faint">{e.aiLabel}</span> : null}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {e?.durationMin ? <Chip>About {e.durationMin >= 90 ? `${Math.round(e.durationMin / 60)} h` : `${e.durationMin} min`}</Chip> : null}
        {e?.priceLevel ? <Chip>{PRICE[e.priceLevel] ?? e.priceLevel}</Chip> : null}
        {e?.bestTime ? <Chip>{BEST[e.bestTime] ?? e.bestTime}</Chip> : null}
        {e?.indoor != null ? <Chip>{e.indoor ? "Indoors" : "Outdoors"}</Chip> : null}
        {(e?.goodFor ?? []).slice(0, 3).map((g) => (
          <Chip key={g}>Good for {String(g).replace(/_/g, " ")}</Chip>
        ))}
        {a.tags.map((t) => (
          <Chip key={t}>#{t}</Chip>
        ))}
      </div>
      {stamp ? (
        <div className="pointer-events-none mt-auto flex justify-end" aria-hidden>
          <svg viewBox="0 0 120 120" className="h-24 w-24 -rotate-12 text-stamp/70">
            <circle cx="60" cy="60" r="54" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="5 3" />
            <circle cx="60" cy="60" r="42" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <text x="60" y="56" textAnchor="middle" className="fill-current font-mono text-[15px] font-semibold uppercase tracking-[0.12em]">
              {a.cityName.length > 9 ? a.cityCode : a.cityName}
            </text>
            <text x="60" y="74" textAnchor="middle" className="fill-current font-mono text-[10px] uppercase">
              {stamp}
            </text>
          </svg>
        </div>
      ) : null}
      <div className={`${stamp ? "" : "mt-auto "}flex items-center justify-between border-t border-dashed border-line pt-3 text-xs text-ink-soft`}>
        <span data-testid="swipe-tally">{yes + no === 0 ? "Nobody has voted yet" : `${yes} yes · ${no} no so far`}</span>
        {a.plannedIn.length ? <span className="text-ok">Planned on {a.plannedIn.length} route{a.plannedIn.length === 1 ? "" : "s"}</span> : null}
      </div>
    </div>
  );
}

function Deck({ tripId, route }: { tripId: string; route: RouteView | undefined }) {
  const cities = useMemo(() => {
    const out: { code: string; name: string; stopId: string }[] = [];
    for (const s of route?.stops ?? []) if (!out.some((c) => c.code === s.city.code)) out.push({ code: s.city.code, name: s.city.name, stopId: s.id });
    return out;
  }, [route]);
  const [city, setCity] = useState<string | null>(null);
  const activeCity = city ?? cities[0]?.code ?? null;
  const cityName = cities.find((c) => c.code === activeCity)?.name ?? "every city";
  const [queue, setQueue] = useState<LibraryActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [exhausted, setExhausted] = useState(false);
  const [history, setHistory] = useState<Done[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  const vote = useVote();
  const plan = usePlanToggle(route?.route.id ?? "");
  const canPlan = Boolean(route && hasRole(route.role, "editor"));

  // Only the latest request may fill the deck: switching city mid-load must not mix decks.
  const request = useRef(0);
  const load = useCallback(
    async (reset: boolean) => {
      const mine = ++request.current;
      if (reset) seen.current = new Set();
      setLoading(true);
      setError(null);
      try {
        const more = await fetchDeck(tripId, activeCity, seen.current);
        if (mine !== request.current) return;
        for (const m of more) seen.current.add(m.id);
        setQueue((q) => (reset ? more : [...q, ...more]));
        setExhausted(more.length === 0);
      } catch (e) {
        if (mine === request.current) setError(e);
      } finally {
        if (mine === request.current) setLoading(false);
      }
    },
    [tripId, activeCity],
  );

  useEffect(() => {
    setHistory([]);
    setQueue([]);
    void load(true);
  }, [load]);

  // Keep a few cards ready behind the top one.
  useEffect(() => {
    if (!loading && !exhausted && !error && queue.length > 0 && queue.length < 4) void load(false);
  }, [queue.length, loading, exhausted, error, load]);

  const top = queue[0];
  const stampFor = (code: string) => {
    const stop = route?.stops.find((s) => s.city.code === code);
    return stop ? `${shortDate(stop.arrive)}–${shortDate(stop.depart).replace(/^[A-Za-z]+ /, (m) => (shortDate(stop.arrive).startsWith(m) ? "" : m))}` : undefined;
  };
  const commit = useCallback(
    (dir: Dir) => {
      if (!top) return;
      const done: Done = { card: top, dir };
      if (dir !== "skip") vote.mutate({ activityId: top.id, value: DIR_VALUE[dir] });
      if (dir === "must" && canPlan) {
        const stop = route?.stops.find((s) => s.city.code === top.cityCode);
        if (stop && !stop.planned.some((p) => p.id === top.id)) {
          plan.mutate({ stopId: stop.id, activityId: top.id, planned: true, title: top.title });
          done.plannedAt = stop.id;
        }
      }
      const others = (top.ups ?? 0) + (top.downs ?? 0);
      setSaid(
        dir === "skip"
          ? `Skipped ${top.title}`
          : `${dir === "no" ? "No" : dir === "must" ? "Must do" : "Yes"} to ${top.title}${done.plannedAt ? ", planned in " + top.cityName : ""}${others ? `. ${top.ups ?? 0} yes and ${top.downs ?? 0} no from the others` : ""}`,
      );
      setHistory((h) => [...h, done].slice(-30));
      setQueue((q) => q.slice(1));
    },
    [top, vote, plan, canPlan, route],
  );

  const undo = useCallback(() => {
    const last = history.at(-1);
    if (!last) return;
    if (last.dir !== "skip") vote.mutate({ activityId: last.card.id, value: last.card.myVote });
    if (last.plannedAt) plan.mutate({ stopId: last.plannedAt, activityId: last.card.id, planned: false, title: last.card.title });
    setHistory((h) => h.slice(0, -1));
    setQueue((q) => [last.card, ...q]);
    setSaid(`Undone: ${last.card.title} is back`);
  }, [history, vote, plan]);

  // Keyboard: arrows to vote, U or Backspace to undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const map: Record<string, Dir> = { ArrowRight: "yes", ArrowLeft: "no", ArrowUp: "must", ArrowDown: "skip" };
      if (map[e.key]) {
        e.preventDefault();
        fling(map[e.key]!);
      } else if (e.key === "u" || e.key === "U" || e.key === "Backspace") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Dragging the top card.
  const cardRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [leaving, setLeaving] = useState<Dir | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const fling = (dir: Dir) => {
    if (!top || leaving) return;
    if (reduce) return commit(dir);
    setLeaving(dir);
    window.setTimeout(() => {
      commit(dir);
      setLeaving(null);
      setDrag(null);
    }, 220);
  };

  const onDown = (e: ReactPointerEvent) => {
    if (leaving) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag({ x: 0, y: 0 });
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!start.current || start.current.id !== e.pointerId) return;
    setDrag({ x: e.clientX - start.current.x, y: e.clientY - start.current.y });
  };
  const onUp = () => {
    if (!start.current || !drag) return;
    start.current = null;
    const w = cardRef.current?.offsetWidth ?? 320;
    const h = cardRef.current?.offsetHeight ?? 480;
    if (drag.x > w * 0.35) return fling("yes");
    if (drag.x < -w * 0.35) return fling("no");
    if (drag.y < -h * 0.28) return fling("must");
    if (drag.y > h * 0.28) return fling("skip");
    setDrag(null);
  };

  const offset = leaving
    ? { x: leaving === "yes" ? 900 : leaving === "no" ? -900 : 0, y: leaving === "must" ? -900 : leaving === "skip" ? 900 : 0 }
    : (drag ?? { x: 0, y: 0 });
  const w = cardRef.current?.offsetWidth ?? 320;
  const yesFade = Math.max(0, Math.min(1, offset.x / (w * 0.35)));
  const noFade = Math.max(0, Math.min(1, -offset.x / (w * 0.35)));
  const mustFade = Math.max(0, Math.min(1, -offset.y / 140));

  return (
    <div className="mx-auto grid max-w-5xl gap-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <section aria-label="Swipe ideas" className="min-w-0 space-y-4">
        {cities.length ? (
          <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="City">
            {cities.map((c) => (
              <button
                key={c.code}
                role="tab"
                aria-selected={c.code === activeCity}
                onClick={() => setCity(c.code)}
                className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${c.code === activeCity ? "bg-board text-amber" : "bg-card text-ink-soft ring-1 ring-line hover:text-ink"}`}
              >
                {c.name}
              </button>
            ))}
          </div>
        ) : null}

        <div className="relative h-[30rem] select-none" data-testid="swipe-deck">
          {error ? <ErrorNote error={error} /> : null}
          {!top && loading ? (
            <div className="grid h-full place-items-center rounded-3xl border border-dashed border-line">
              <Spinner label="Shuffling ideas" />
            </div>
          ) : null}
          {!top && !loading && !error ? (
            <div className="grid h-full place-items-center rounded-3xl border border-dashed border-line bg-card p-6 text-center" data-testid="swipe-done">
              <div className="space-y-3">
                <p className="text-lg font-semibold">That&apos;s every idea in {cityName}</p>
                <p className="text-sm text-ink-soft">See where the group agrees, or move on to the next city.</p>
                {(() => {
                  const i = cities.findIndex((c) => c.code === activeCity);
                  const next = cities[i + 1];
                  return next ? (
                    <Button variant="primary" onClick={() => setCity(next.code)}>
                      Next: {next.name}
                    </Button>
                  ) : null;
                })()}
              </div>
            </div>
          ) : null}
          {/* The next two cards peek out behind the top one. */}
          {queue.slice(1, 3).map((a, i) => (
            <div
              key={a.id}
              aria-hidden
              className={`${CARD} overflow-hidden`}
              style={{ transform: `translateY(${(i + 1) * 10}px) scale(${1 - (i + 1) * 0.04})`, zIndex: 2 - i, opacity: 1 - (i + 1) * 0.25 }}
            />
          ))}
          {top ? (
            <div
              ref={cardRef}
              key={top.id}
              data-testid="swipe-card"
              data-id={top.id}
              className={`${CARD} z-10 cursor-grab touch-none overflow-hidden active:cursor-grabbing`}
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) rotate(${offset.x / 22}deg)`,
                transition: drag && !leaving ? "none" : "transform 220ms cubic-bezier(.2,.7,.3,1)",
              }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={() => {
                start.current = null;
                setDrag(null);
              }}
            >
              <Card a={top} stamp={stampFor(top.cityCode)} />
              <span className="pointer-events-none absolute left-5 top-14 -rotate-12 rounded-lg border-4 border-ok px-3 py-1 text-2xl font-black tracking-widest text-ok" style={{ opacity: yesFade }} aria-hidden>
                YES
              </span>
              <span className="pointer-events-none absolute right-5 top-14 rotate-12 rounded-lg border-4 border-err px-3 py-1 text-2xl font-black tracking-widest text-err" style={{ opacity: noFade }} aria-hidden>
                NOPE
              </span>
              <span className="pointer-events-none absolute inset-x-0 bottom-16 mx-auto w-max rounded-lg border-4 border-mark bg-card px-3 py-1 text-xl font-black tracking-widest text-ink" style={{ opacity: mustFade }} aria-hidden>
                MUST DO
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-center gap-3" aria-label="Vote">
          <Button size="md" variant="secondary" onClick={undo} disabled={!history.length} aria-label="Undo the last swipe" className="h-11 w-11 rounded-full p-0">
            <UndoIcon />
          </Button>
          <Button size="md" variant="danger" onClick={() => fling("no")} disabled={!top} aria-label="No" className="h-14 w-14 rounded-full p-0">
            <ThumbDownIcon className="h-6 w-6" />
          </Button>
          <Button size="md" variant="secondary" onClick={() => fling("must")} disabled={!top} aria-label={canPlan ? "Must do: yes, and plan it" : "Must do"} className="h-12 w-12 rounded-full p-0">
            <UpIcon className="h-6 w-6 text-mark" />
          </Button>
          <Button size="md" variant="primary" onClick={() => fling("yes")} disabled={!top} aria-label="Yes" className="h-14 w-14 rounded-full p-0">
            <ThumbUpIcon className="h-6 w-6" />
          </Button>
          <Button size="md" variant="ghost" onClick={() => fling("skip")} disabled={!top} aria-label="Skip for now" className="h-11 w-11 rounded-full p-0">
            <DownIcon />
          </Button>
        </div>
        <p className="text-center text-xs text-ink-faint">Swipe or use the arrow keys: → yes, ← no, ↑ must do, ↓ skip, U undo.</p>
        <p className="min-h-[1.25rem] text-center text-sm text-ink-soft" role="status" aria-live="polite" data-testid="swipe-status">
          {said}
        </p>
      </section>

      <section aria-label="Group taste" className="min-w-0">
        <GroupTaste tripId={tripId} />
      </section>
    </div>
  );
}

function SwipeScreen({ tripId }: { tripId: string }) {
  const trip = useTrip(tripId);
  const routeId = trip.data?.routes.find((r) => r.isCurrent)?.id ?? trip.data?.routes[0]?.id ?? "";
  const route = useRoute(routeId);
  return (
    <>
      <BoardHeader
        eyebrow={`${trip.data?.trip.name ?? "Trip"} · ideas`}
        title="Swipe"
        width="max-w-5xl"
        meta={route.data ? <BoardStat label="Route" value={route.data.route.name} /> : null}
        actions={
          <Link href={`/trips/${tripId}/library`}>
            <Button size="sm" variant="board">
              All ideas
            </Button>
          </Link>
        }
      />
      {trip.error ? <ErrorNote error={trip.error} /> : null}
      {trip.data && (!routeId || route.data) ? <Deck tripId={tripId} route={route.data} /> : <div className="p-6"><Spinner /></div>}
    </>
  );
}

export default function SwipePage() {
  const { tripId } = useParams<{ tripId: string }>();
  return (
    <RequireAuth>
      <SwipeScreen tripId={tripId} />
    </RequireAuth>
  );
}
