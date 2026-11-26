"use client";

import type { RouteView } from "@trippr/contracts";
import {
  addDays,
  bookingNames,
  busyPeriods,
  daysBetween,
  editImpact,
  HOME,
  listNames,
  shortDate,
  stopPace,
  weekday,
  withNights,
  type EditImpact,
  type NightsChange,
  type RouteAnchors,
  type RuleLeg,
  type RuleStop,
} from "@trippr/rules";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

interface Drag {
  /** Boundary index: the end of stop i (the last one is the home date). */
  i: number;
  startX: number;
  delta: number;
}

/**
 * The trip as one strip under the route's board header, a day per notch.
 * Drag the line between two stops to move a night from one to the other;
 * the line after the last stop moves the home date. Booked dates resist: a
 * drag that would move one turns red and asks first.
 */
export function TripStrip({
  view,
  rules,
  home,
  anchors,
  canEdit,
  onChange,
  onBlocked,
}: {
  view: RouteView;
  rules: (RuleStop & { view: unknown })[];
  home: RuleLeg[];
  anchors: RouteAnchors;
  canEdit: boolean;
  /** A change that keeps every booking: save it (with Undo). */
  onChange: (changes: NightsChange[], impact: EditImpact) => void;
  /** A change that would move a booking: ask first. */
  onBlocked: (changes: NightsChange[], impact: EditImpact, label: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [said, setSaid] = useState("");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const start = view.trip.startDate;
  const stops = view.stops;

  /** The changes for moving boundary i by delta days, or null when a stop would go below zero nights. */
  const changesFor = (i: number, delta: number): NightsChange[] | null => {
    if (!delta) return [];
    const left = rules[i]!;
    const right = rules[i + 1];
    if (left.nights + delta < 0) return null;
    if (!right) return [{ stopId: left.id, nights: left.nights + delta }];
    if (right.nights - delta < 0) return null;
    return [
      { stopId: left.id, nights: left.nights + delta },
      { stopId: right.id, nights: right.nights - delta },
    ];
  };

  const preview = useMemo(() => {
    if (!drag || !drag.delta) return null;
    const changes = changesFor(drag.i, drag.delta);
    if (!changes) return null;
    return { changes, after: withNights(rules, changes), impact: editImpact(start, rules, withNights(rules, changes), home) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, rules, start, home]);

  const nightsOf = (k: number) => preview?.after[k]?.nights ?? stops[k]!.nights;
  const total = Math.max(1, stops.reduce((n, _, k) => n + nightsOf(k), 0));
  // Never less than a few pixels a day, so a long trip stays readable (it scrolls inside the strip).
  const pxPerDay = Math.max(width / Math.max(total, view.checks.totalNights), 6);
  const inner = Math.max(width, pxPerDay * total);
  const x = (day: number) => day * pxPerDay;

  // Where each stop starts, in days from the trip start.
  const starts: number[] = [];
  stops.forEach((_, k) => starts.push(k === 0 ? 0 : starts[k - 1]! + nightsOf(k - 1)));
  const end = addDays(start, total);

  const countryKey = [...new Set(stops.map((s) => s.country.iso))].join(",");
  const busy = useMemo(() => busyPeriods(start, end, countryKey.split(",")), [start, end, countryKey]);

  const moving = drag && preview ? bookingNames(preview.impact.breaks) : [];
  const labelFor = (i: number, delta: number) => {
    const left = stops[i]!;
    const right = stops[i + 1];
    if (!right) return delta > 0 ? `${left.city.name} gets ${delta} more night${delta === 1 ? "" : "s"}; home moves later` : `${left.city.name} gives up ${-delta} night${delta === -1 ? "" : "s"}; home moves earlier`;
    const [gain, lose, d] = delta > 0 ? [left, right, delta] : [right, left, -delta];
    return `${d === 1 ? "A night" : `${d} nights`} from ${lose.city.name} to ${gain.city.name}`;
  };

  const commit = (i: number, delta: number) => {
    const changes = changesFor(i, delta);
    if (!changes || !changes.length) return;
    const impact = editImpact(start, rules, withNights(rules, changes), home);
    const label = labelFor(i, delta);
    setSaid(label);
    if (impact.breaks.length) onBlocked(changes, impact, label);
    else onChange(changes, impact);
  };

  const onDown = (i: number) => (e: PointerEvent<HTMLButtonElement>) => {
    if (!canEdit) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ i, startX: e.clientX, delta: 0 });
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.startX) / pxPerDay);
    if (delta !== drag.delta && changesFor(drag.i, delta)) setDrag({ ...drag, delta });
  };
  const onUp = () => {
    if (!drag) return;
    const { i, delta } = drag;
    setDrag(null);
    commit(i, delta);
  };
  const onKey = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      commit(i, e.key === "ArrowRight" ? 1 : -1);
    }
  };

  const pinsAt = (k: number) => anchors.anchors.filter((a) => a.strength === "booked" && a.kind !== "event" && a.stopId === stops[k]?.id && a.side === "arrive");
  const homePin = anchors.anchors.find((a) => a.stopId === HOME && a.strength === "booked");
  const events = stops.flatMap((s, k) =>
    s.planned.flatMap((p) => {
      const on = p.when && "on" in p.when ? p.when.on : null;
      if (!on) return [];
      const d = daysBetween(start, on);
      return d >= 0 && d <= total ? [{ id: `${s.id}-${p.id}`, title: p.title, day: d, fits: d >= starts[k]! && d <= starts[k]! + nightsOf(k) }] : [];
    }),
  );

  // Day labels: every day when there's room, otherwise each Monday.
  const every = pxPerDay >= 30 ? 1 : 7;

  if (!stops.length) return null;
  return (
    <div className="border-t border-board-3 bg-board-2" data-testid="trip-strip">
      <div className="mx-auto max-w-6xl px-4 pb-2.5 pt-2 sm:px-6">
        <div ref={ref} className="overflow-x-auto overflow-y-visible">
          <div className="relative" style={{ width: inner, height: 86 }}>
            {/* Busy holiday periods along the top. */}
            {busy.map((b) => {
              const from = Math.max(0, daysBetween(start, b.from));
              const to = Math.min(total, daysBetween(start, b.to) + 1);
              if (to <= from) return null;
              return (
                <div
                  key={b.name + b.from}
                  className="absolute top-0 flex h-4 items-center overflow-hidden rounded-sm bg-mark/25 px-1 text-[9px] font-semibold uppercase tracking-[0.1em] text-amber"
                  style={{ left: x(from), width: x(to) - x(from) }}
                  title={`${b.name}, ${shortDate(b.from)} to ${shortDate(b.to)}: ${b.note} (typical dates)`}
                  data-testid="busy-period"
                >
                  <span className="truncate">{b.name}</span>
                </div>
              );
            })}

            {/* Weekends as faint columns behind the stops. */}
            {Array.from({ length: total }, (_, d) =>
              [0, 6].includes(weekday(addDays(start, d))) ? <div key={d} className="absolute bg-white/5" style={{ left: x(d), width: pxPerDay, top: 18, height: 44 }} aria-hidden /> : null,
            )}

            {/* The stops. */}
            <ol className="absolute inset-x-0 flex" style={{ top: 22, height: 36 }} aria-label="Nights per stop">
              {stops.map((s, k) => {
                const n = nightsOf(k);
                const pace = stopPace({ nights: n, arriveAt: s.legs.at(-1)?.arriveAt, planned: s.planned });
                const changed = preview && n !== s.nights;
                return (
                  <li
                    key={s.id}
                    className={`relative flex flex-col items-center justify-center overflow-hidden text-white transition-[width] duration-75 ${changed ? "ring-2 ring-inset ring-amber" : ""}`}
                    style={{ width: Math.max(x(n), 3), background: s.country.color ?? "#5b616b", borderRight: "1px solid var(--color-board-2)" }}
                    title={`${s.city.name}: ${n} night${n === 1 ? "" : "s"}, ${shortDate(addDays(start, starts[k]!))} to ${shortDate(addDays(start, starts[k]! + n))}`}
                  >
                    {x(n) > 26 ? <span className="font-mono text-[10px] font-semibold leading-none">{s.city.code}</span> : null}
                    {x(n) > 26 ? <span className="text-[10px] leading-none opacity-85">{n}</span> : null}
                    {pace.level !== "empty" ? (
                      <span
                        className={`absolute bottom-0 left-0 h-1 ${pace.level === "over" ? "bg-err" : pace.level === "full" ? "bg-amber" : "bg-white/60"}`}
                        style={{ width: `${Math.min(100, (pace.used / Math.max(pace.slots, 1)) * 100)}%` }}
                        aria-hidden
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>

            {/* Fixed-date events as stars under the strip. */}
            {events.map((e) => (
              <span
                key={e.id}
                className={`absolute h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-2 border-board-2 ${e.fits ? "bg-stamp" : "bg-err"}`}
                style={{ left: x(e.day) + pxPerDay / 2, top: 55 }}
                title={`${e.title}, ${shortDate(addDays(start, e.day))}${e.fits ? "" : " (outside the stop's dates)"}`}
              />
            ))}

            {/* Booked dates as pins on the line where a stop starts, and on the home date. */}
            {stops.map((s, k) =>
              pinsAt(k).length ? (
                <span
                  key={`pin-${s.id}`}
                  className={`absolute top-[16px] h-[46px] w-0.5 -translate-x-1/2 ${pinsAt(k).every((p) => p.holds) ? "bg-ok" : "bg-err"}`}
                  style={{ left: x(starts[k]!) }}
                  title={pinsAt(k)
                    .map((p) => `${p.label}: ${shortDate(p.from)}${p.holds ? "" : ` (plan says ${shortDate(p.planDate)})`}`)
                    .join("\n")}
                  data-testid="strip-pin"
                />
              ) : null,
            )}
            {homePin ? (
              <span className={`absolute top-[16px] h-[46px] w-0.5 -translate-x-1/2 ${homePin.holds ? "bg-ok" : "bg-err"}`} style={{ left: x(total) }} title={`${homePin.label}: ${shortDate(homePin.from)}`} />
            ) : null}

            {/* Drag handles on the lines between stops, and after the last one. */}
            {canEdit
              ? stops.map((s, k) => {
                  const at = starts[k]! + nightsOf(k);
                  const active = drag?.i === k;
                  const bad = active && moving.length > 0;
                  const next = stops[k + 1];
                  return (
                    <button
                      key={`h-${s.id}`}
                      type="button"
                      className={`absolute top-[18px] z-10 flex h-[44px] w-4 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center focus-visible:outline-2 focus-visible:outline-amber`}
                      style={{ left: x(at) }}
                      onPointerDown={onDown(k)}
                      onPointerMove={onMove}
                      onPointerUp={onUp}
                      onPointerCancel={() => setDrag(null)}
                      onKeyDown={onKey(k)}
                      aria-label={next ? `Line between ${s.city.name} and ${next.city.name}. Arrow keys move a night between them.` : `End of ${s.city.name}, the home date. Arrow keys add or remove a night.`}
                      data-testid="strip-handle"
                      data-index={k}
                    >
                      <span className={`h-full w-1 rounded-full ${bad ? "bg-err" : active ? "bg-amber" : "bg-white/35 hover:bg-amber"}`} />
                    </button>
                  );
                })
              : null}

            {/* Day labels along the bottom. */}
            {Array.from({ length: total + 1 }, (_, d) => {
              const date = addDays(start, d);
              if (d % every !== 0 && !(every === 7 && weekday(date) === 1)) return null;
              if (every === 7 && weekday(date) !== 1) return null;
              return (
                <span key={d} className="absolute font-mono text-[9px] text-amber-soft/60" style={{ left: x(d), top: 68 }} aria-hidden>
                  {shortDate(date)}
                </span>
              );
            })}
          </div>
        </div>
        <div className="flex min-h-[1.25rem] items-center justify-between gap-3 font-mono text-[11px] text-amber-soft/70">
          <span>{shortDate(start)}</span>
          <span className={`truncate text-center ${moving.length ? "text-err" : "text-amber"}`} role="status" aria-live="polite" data-testid="strip-status">
            {drag && preview
              ? `${labelFor(drag.i, drag.delta)}${moving.length ? ` · moves ${listNames(moving)}` : ""}`
              : said || (canEdit ? "Drag a line between stops to move nights" : "")}
          </span>
          <span>{shortDate(end)}</span>
        </div>
      </div>
    </div>
  );
}
