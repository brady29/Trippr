"use client";

/**
 * The route builder's view of anchors: dates that bookings fix. The rules
 * module decides (packages/rules/src/anchors.ts); these pieces show it.
 */
import type { StopView } from "@trippr/contracts";
import {
  allRefundable,
  bookingNames,
  listNames,
  shortDate,
  type AnchorState,
  type Check,
  type EditImpact,
  type Fix,
  type NightsChange,
  type NightsOption,
  type NightsPlan,
  type StopLock,
} from "@trippr/rules";
import { useEffect, useRef, type ReactNode } from "react";
import { useDialogFocus } from "@/lib/focus";
import { LockIcon, UndoIcon, XIcon } from "./icons";
import { Button, LevelIcon } from "./ui";

const nightsWord = (n: number) => `${n} night${n === 1 ? "" : "s"}`;
/** Today in the traveller's time zone, YYYY-MM-DD. */
export const today = () => new Date().toLocaleDateString("en-CA");
/** The soonest free-cancellation deadline among some anchors. */
const freeUntil = (anchors: readonly AnchorState[]) => anchors.map((a) => a.refundableUntil).filter((d): d is string => Boolean(d)).sort()[0];
const range = (from: string, to: string) => (from === to ? shortDate(from) : `${shortDate(from)} to ${shortDate(to)}`);

/** What an edit did, for the change bar: nights, the home date, and the bookings it moved or put back. */
export function impactParts(impact: EditImpact, hasBookings: boolean): string[] {
  const parts: string[] = [];
  if (impact.homeBefore !== impact.homeAfter) parts.push(`home ${shortDate(impact.homeBefore)} → ${shortDate(impact.homeAfter)}`);
  const broken = bookingNames(impact.breaks);
  if (broken.length) parts.push(`${listNames(broken)} ${broken.length === 1 ? "is" : "are"} now off ${broken.length === 1 ? "its" : "their"} booked dates`);
  const fixed = bookingNames(impact.fixes);
  if (fixed.length) parts.push(`${listNames(fixed)} back on ${fixed.length === 1 ? "its" : "their"} booked dates`);
  const soft = bookingNames(impact.softBreaks);
  if (soft.length) parts.push(`${listNames(soft)} no longer ${soft.length === 1 ? "fits" : "fit"}`);
  if (!broken.length && !fixed.length && hasBookings) parts.push("no bookings moved");
  return parts;
}

export function nightsMessage(stops: StopView[], changes: NightsChange[], impact: EditImpact, hasBookings: boolean): string {
  const nights = changes.map((c) => {
    const s = stops.find((x) => x.id === c.stopId);
    return s ? `${s.city.name} ${s.nights} → ${nightsWord(c.nights)}` : "";
  });
  return [...nights.filter(Boolean), ...impactParts(impact, hasBookings)].join(" · ");
}

/** A stop's own fixed dates: booked tickets into it and its booked hotel. Events already show as plan chips. */
export function PinRow({ pins, lock }: { pins: AnchorState[]; lock: StopLock }) {
  const shown = pins.filter((p) => p.kind !== "event");
  if (!shown.length && lock !== "boxed") return null;
  // A hotel's check-in and check-out read as one booking.
  const stays = new Map<string, AnchorState[]>();
  const legs: AnchorState[] = [];
  for (const p of shown) {
    if (p.hotelId) stays.set(p.hotelId, [...(stays.get(p.hotelId) ?? []), p]);
    else legs.push(p);
  }
  const chip = (key: string, holds: boolean, soft: boolean, text: ReactNode, off?: string) => (
    <li
      key={key}
      data-testid="pin"
      data-holds={holds}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs ${
        !holds ? "bg-err/10 text-err" : soft ? "border border-dashed border-ink-faint text-ink-soft" : "bg-ok/10 text-ok"
      }`}
    >
      <LockIcon className="h-3 w-3 shrink-0" />
      <span className="truncate">{text}</span>
      {off ? <span className="shrink-0 font-medium">· {off}</span> : null}
    </li>
  );
  return (
    <ul className="flex flex-wrap items-center gap-1.5" aria-label="Fixed dates">
      {legs.map((p) => {
        const verb = p.from === p.to ? "arrives" : "departs";
        return chip(
          p.id,
          p.holds,
          p.strength === "soft",
          <>
            {p.strength === "soft" ? "Held · " : ""}
            {p.label} <span className="font-mono">{verb} {shortDate(p.from)}</span>
            {p.refundableUntil && p.refundableUntil >= today() ? <span className="opacity-80"> · free to cancel until {shortDate(p.refundableUntil)}</span> : null}
          </>,
          p.holds ? undefined : `plan says ${shortDate(p.planDate)}`,
        );
      })}
      {[...stays.values()].map((pair) => {
        const inn = pair.find((p) => p.kind === "stay-in");
        const out = pair.find((p) => p.kind === "stay-out");
        const holds = pair.every((p) => p.holds);
        return chip(
          pair[0]!.id,
          holds,
          false,
          <>
            {pair[0]!.booking} <span className="font-mono">{inn && out ? `${shortDate(inn.from)} → ${shortDate(out.from)}` : range(pair[0]!.from, pair[0]!.to)}</span>
            {pair[0]!.refundableUntil && pair[0]!.refundableUntil >= today() ? <span className="opacity-80"> · free to cancel until {shortDate(pair[0]!.refundableUntil)}</span> : null}
          </>,
          holds ? undefined : `plan says ${inn ? shortDate(inn.planDate) : ""}${out ? ` → ${shortDate(out.planDate)}` : ""}`,
        );
      })}
      {lock === "boxed" ? (
        <li
          className="rounded-full bg-paper-2 px-2.5 py-0.5 text-xs text-ink-soft"
          title="Bookings fix both the day you arrive and the day you leave, so this stop's nights only change if a booking moves."
          data-testid="boxed"
        >
          Between two bookings
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Shown on a stop when one more or one fewer night would move a booked date:
 * trades with other stops that keep every booking, then moving the dates anyway.
 */
export function TradePanel({
  stop,
  stops,
  delta,
  plan,
  lock,
  pending,
  onPick,
  onCancel,
}: {
  stop: StopView;
  stops: StopView[];
  delta: number;
  plan: NightsPlan;
  lock: StopLock;
  pending: boolean;
  onPick: (option: NightsOption) => void;
  onCancel: () => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const city = stop.city.name;
  const blocking = bookingNames(plan.shift.impact.breaks);
  const ownStay = plan.shift.impact.breaks.find((a) => a.stopId === stop.id && a.hotelId);
  const nameOf = (id: string) => stops.find((s) => s.id === id)?.city.name ?? "another stop";
  const nightsOf = (id: string) => stops.find((s) => s.id === id)?.nights ?? 0;

  const explain =
    lock === "booked" && ownStay
      ? `${ownStay.booking} is booked for ${nightsWord(stop.nights)}. Changing ${city}'s nights means changing that booking too.`
      : plan.trades.length
        ? `${listNames(blocking)} ${blocking.length === 1 ? "is" : "are"} booked for set dates, so ${delta > 0 ? "take the night from" : "give the night to"} another stop and every booking stays put.`
        : `${city} sits between fixed dates and no other stop can trade without moving a booking. ${listNames(blocking)} would need changing.`;

  return (
    <section className="space-y-2.5 rounded-xl bg-mark/15 p-3" role="region" aria-label={`Options for ${city}`} data-testid="trade-panel">
      <div>
        <h3 className="text-sm font-semibold">
          {delta > 0 ? `${city} can't get another night without moving a booking` : `${city} can't lose a night without moving a booking`}
        </h3>
        <p className="mt-0.5 text-xs text-ink-soft">{explain}</p>
      </div>
      <div className="grid gap-1.5">
        {plan.trades.map((t, i) => {
          const other = t.withStopId!;
          const after = nightsOf(other) - delta;
          const soft = bookingNames(t.impact.softBreaks);
          return (
            <button
              key={other}
              ref={i === 0 ? first : undefined}
              disabled={pending}
              onClick={() => onPick(t)}
              data-testid="trade-option"
              className={`grid gap-0.5 rounded-lg border bg-card px-3 py-2 text-left hover:border-ink-soft disabled:opacity-60 ${i === 0 ? "border-ok" : "border-line"}`}
            >
              <span className="text-sm font-semibold">
                {delta > 0 ? `Take a night from ${nameOf(other)}` : `Give the night to ${nameOf(other)}`}
                {i === 0 ? <span className="ml-2 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-ok">Suggested</span> : null}
              </span>
              <span className="text-xs text-ink-soft">
                {nameOf(other)} {nightsOf(other)} → {nightsWord(after)}
                {after === 0 ? " (a day stop)" : ""}. No bookings move.
                {soft.length ? ` ${listNames(soft)} would no longer fit.` : ""}
              </span>
            </button>
          );
        })}
        <button
          ref={plan.trades.length ? undefined : first}
          disabled={pending}
          onClick={() => onPick(plan.shift)}
          data-testid="shift-option"
          className="grid gap-0.5 rounded-lg border border-line bg-card px-3 py-2 text-left hover:border-err disabled:opacity-60"
        >
          <span className="text-sm font-semibold text-err">Move the dates anyway</span>
          <span className="text-xs text-ink-soft">
            Everything after {city} moves a day {delta > 0 ? "later" : "earlier"}.{" "}
            {allRefundable(plan.shift.impact.breaks, today())
              ? `You can still change ${listNames(blocking)} for free, until ${shortDate(freeUntil(plan.shift.impact.breaks)!)}.`
              : `${listNames(blocking)} would need changing.`}
          </span>
        </button>
      </div>
      <button onClick={onCancel} className="text-xs text-ink-soft underline hover:text-ink">
        Cancel, keep {city} at {nightsWord(stop.nights)}
      </button>
    </section>
  );
}

export interface Change {
  id: number;
  message: string;
  /** Absent when the change can't be undone from here. */
  undo?: () => void;
}

/** The last change, what it did, and Undo. Sticks to the bottom of the stops column. */
export function ChangeBar({ change, depth, onDismiss }: { change: Change | null; depth: number; onDismiss: () => void }) {
  if (!change) return null;
  return (
    <div
      className="sticky bottom-3 z-20 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-board px-3 py-2.5 text-xs text-amber-soft shadow-xl"
      role="status"
      aria-live="polite"
      data-testid="change-bar"
    >
      <span className="min-w-0 flex-1 basis-60">{change.message}</span>
      {change.undo ? (
        <Button size="sm" variant="board" onClick={change.undo} data-testid="undo">
          <UndoIcon className="h-3.5 w-3.5" />
          Undo{depth > 1 ? ` (${depth})` : ""}
        </Button>
      ) : null}
      <button onClick={onDismiss} aria-label="Dismiss" className="rounded p-1 hover:bg-board-3">
        <XIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export interface Guard {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}

/** An in-page confirmation for a change that moves bookings or can't be undone. */
export function GuardDialog({ guard, onCancel }: { guard: Guard; onCancel: () => void }) {
  const confirm = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useDialogFocus(box, onCancel, confirm);
  return (
    <div ref={box} className="fixed inset-0 z-50 grid place-items-center p-4" role="alertdialog" aria-modal="true" aria-labelledby="guard-title" aria-describedby="guard-body">
      {/* Clicking outside cancels; keyboard and screen reader users have the Cancel button and Escape. */}
      <div className="absolute inset-0 bg-board/50" aria-hidden onClick={onCancel} />
      <div className="relative w-full max-w-md space-y-3 rounded-2xl border border-line bg-card p-5 shadow-2xl">
        <h2 id="guard-title" className="text-base font-semibold">
          {guard.title}
        </h2>
        <div id="guard-body" className="space-y-2 text-sm text-ink-soft">
          {guard.body}
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            ref={confirm}
            variant="danger"
            onClick={() => {
              guard.onConfirm();
              onCancel();
            }}
          >
            {guard.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * A check that belongs to this stop, on the stop itself, with the fixes the
 * engine found. Every fix keeps the bookings that are on their dates.
 */
export function IssueStrip({
  check,
  fixes,
  canEdit,
  pending,
  onFix,
}: {
  check: Check;
  fixes: Fix[];
  canEdit: boolean;
  pending: boolean;
  onFix: (fix: Fix) => void;
}) {
  const error = check.level === "error";
  return (
    <div className={`flex gap-2.5 rounded-xl px-3 py-2.5 text-xs ${error ? "bg-err/10" : "bg-mark/15"}`} data-testid="issue" data-kind={check.kind}>
      <LevelIcon level={check.level} className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div>
          <div className="font-semibold text-ink">{check.title}</div>
          <div className="text-ink-soft">{check.detail}</div>
        </div>
        {canEdit && fixes.length ? (
          <div className="flex flex-wrap gap-1.5">
            {fixes.map((f, i) => (
              <Button
                key={f.label}
                size="sm"
                variant={i === 0 ? "primary" : "secondary"}
                disabled={pending}
                onClick={() => onFix(f)}
                data-testid="fix"
                title={f.impact.homeBefore !== f.impact.homeAfter ? `Home moves to ${shortDate(f.impact.homeAfter)}` : "The home date stays the same"}
              >
                {f.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The sentences for a dialog: which bookings move and where the home date goes. */
export function impactSentences(impact: EditImpact): ReactNode[] {
  const out: ReactNode[] = [];
  const broken = bookingNames(impact.breaks);
  if (broken.length) {
    out.push(
      <p key="b">
        <span className="font-medium text-err">
          {listNames(broken, 4)} would no longer match {broken.length === 1 ? "its" : "their"} booked dates.
        </span>{" "}
        {allRefundable(impact.breaks, today())
          ? `You can still change ${broken.length === 1 ? "it" : "them"} for free, until ${shortDate(freeUntil(impact.breaks)!)}.`
          : `You'd need to change ${broken.length === 1 ? "that booking" : "those bookings"}.`}
      </p>,
    );
  }
  const soft = bookingNames(impact.softBreaks);
  if (soft.length) out.push(<p key="s">{listNames(soft)} would no longer fit the dates.</p>);
  if (impact.homeBefore !== impact.homeAfter) {
    out.push(
      <p key="h">
        Home moves from {shortDate(impact.homeBefore)} to {shortDate(impact.homeAfter)}.
      </p>,
    );
  }
  return out;
}
