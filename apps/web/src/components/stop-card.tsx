"use client";

import type React from "react";

import type { StopView } from "@trippr/contracts";
import { ARRIVE_MODES, dayDate, isFixedDate, whenLabel, type AnchorState, type ArriveMode, type Pace, type StopLock } from "@trippr/rules";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useState } from "react";
import { PinRow } from "./anchors";
import { MapsLink } from "./maps-link";
import { Flaps } from "./shell";
import { DownIcon, GripIcon, LockIcon, MinusIcon, ModeIcon, PlusIcon, StarIcon, UpIcon, XIcon } from "./icons";

export const MODE_LABEL: Record<ArriveMode, string> = {
  flight: "Flight",
  hsr: "High-speed train",
  train: "Train",
  road: "Road",
  boat: "Boat",
};

export interface StopCardActions {
  onNights(nights: number): void;
  onMode(mode: ArriveMode): void;
  onArriveNote(note: string): void;
  onNotes(notes: string): void;
  /** Cost estimates in CAD per person; null clears one. */
  onCosts(patch: { stayCadPerNight?: number | null; arriveCostCad?: number | null }): void;
  onMove(delta: -1 | 1): void;
  onRemove(): void;
  onOpenActivities(): void;
}

/** Save a text field when it loses focus, if it changed. */
function BlurText({
  value,
  onSave,
  disabled,
  multiline,
  ...rest
}: {
  value: string;
  onSave: (v: string) => void;
  disabled: boolean;
  multiline?: boolean;
  placeholder: string;
  "aria-label": string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value.trim()) onSave(draft.trim());
  };
  const cls = `w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm text-ink placeholder:text-ink-faint hover:border-line focus:border-ink-soft focus:bg-card focus:outline-none disabled:hover:border-transparent ${rest.className ?? ""}`;
  return multiline ? (
    <textarea
      value={draft}
      disabled={disabled}
      rows={2}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      placeholder={rest.placeholder}
      aria-label={rest["aria-label"]}
      className={`${cls} resize-y`}
    />
  ) : (
    <input
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      placeholder={rest.placeholder}
      aria-label={rest["aria-label"]}
      className={cls}
    />
  );
}

/** A compact CAD amount saved on blur; an empty box clears the estimate. */
function BlurMoney({
  value,
  onSave,
  disabled,
  label,
  suffix,
}: {
  value: number | null | undefined;
  onSave: (v: number | null) => void;
  disabled: boolean;
  label: string;
  suffix: string;
}) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => setDraft(value == null ? "" : String(value)), [value]);
  const commit = () => {
    const trimmed = draft.trim();
    const next = trimmed === "" ? null : Number(trimmed);
    if (next !== null && (!Number.isFinite(next) || next < 0)) {
      setDraft(value == null ? "" : String(value));
      return;
    }
    if (next !== (value ?? null)) onSave(next);
  };
  return (
    <label className="flex items-center gap-1 rounded-md border border-line bg-paper px-2 py-1 text-xs text-ink-soft">
      <span aria-hidden>$</span>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={draft}
        disabled={disabled}
        placeholder="?"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        aria-label={label}
        className="w-16 bg-transparent font-mono text-xs text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-70"
      />
      <span>{suffix}</span>
    </label>
  );
}

const cadShort = (n: number) => `$${Math.round(n).toLocaleString("en-CA")}`;

const PACE_STYLE: Record<Pace["level"], string> = {
  empty: "text-ink-faint",
  light: "bg-paper-2 text-ink-soft",
  good: "bg-ok/10 text-ok",
  full: "bg-mark/25 text-ink",
  over: "bg-err/10 text-err",
};
const PACE_WORD: Record<Pace["level"], string> = { empty: "", light: "Room to spare", good: "Good pace", full: "Full", over: "Too much" };

/** Plans against the half-days the stop has, counting a late arrival. */
function PaceChip({ pace }: { pace: Pace }) {
  const text = `${pace.used} half-day${pace.used === 1 ? "" : "s"} of plans for about ${pace.slots}${pace.lateArrival ? "; the arrival day is lost to travel" : ""}`;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${PACE_STYLE[pace.level]}`} title={text} data-testid="pace" data-level={pace.level}>
      <span className="flex gap-0.5" aria-hidden>
        {Array.from({ length: Math.min(Math.max(pace.slots, pace.used), 12) }, (_, i) => (
          <i key={i} className={`h-2 w-1.5 rounded-[1px] ${i < pace.used ? (i < pace.slots ? "bg-current" : "bg-err") : "bg-current opacity-25"}`} />
        ))}
      </span>
      {PACE_WORD[pace.level]}
      <span className="sr-only">: {text}</span>
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">{children}</div>;
}

/**
 * One stop on the route, as a ticket: the stub holds the city, the body leads
 * with dates, nights and getting there. Costs and notes open when needed.
 */
export function StopCard({
  stop,
  index,
  count,
  canEdit,
  libraryCount,
  actions,
  getHere,
  stay,
  lock = "free",
  pins = [],
  trade,
  issues,
  issueCount = 0,
  pace,
  compact = false,
}: {
  stop: StopView;
  index: number;
  count: number;
  canEdit: boolean;
  libraryCount?: number;
  actions: StopCardActions;
  /** Tickets and travel options, given the travel-mode row to show at their head. */
  getHere?: (lead: React.ReactNode) => React.ReactNode;
  /** Where the group is staying. */
  stay?: React.ReactNode;
  /** How free this stop's nights are, given the bookings around it. */
  lock?: StopLock;
  /** This stop's fixed dates: booked tickets into it, its booked hotel, held tickets. */
  pins?: AnchorState[];
  /** The trade panel, when a nights change needs a decision. */
  trade?: React.ReactNode;
  /** Checks that belong to this stop, with their fixes. */
  issues?: React.ReactNode;
  issueCount?: number;
  /** How full the stop is, when anything is planned. */
  pace?: Pace;
  /** One line per stop until opened. */
  compact?: boolean;
}) {
  const broken = pins.some((p) => p.strength === "booked" && !p.holds);
  const [expanded, setExpanded] = useState(false);
  const folded = compact && !expanded && !trade;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: stop.id,
    disabled: !canEdit,
  });
  const hasCosts = stop.stayCadPerNight != null || stop.arriveCostCad != null;
  const [costsOpen, setCostsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(Boolean(stop.notes));
  useEffect(() => {
    if (stop.notes) setNotesOpen(true);
  }, [stop.notes]);

  const costSummary = hasCosts
    ? [
        stop.stayCadPerNight != null ? `${cadShort(stop.stayCadPerNight)}/night` : null,
        stop.arriveCostCad != null ? `${cadShort(stop.arriveCostCad)} to get here` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Add costs";

  const modeRow = (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 rounded-md border border-line bg-paper px-2 py-1 text-xs text-ink-soft">
        <ModeIcon mode={stop.arriveMode} className={stop.arriveMode === "flight" ? "text-sky" : "text-rail"} />
        <span className="sr-only">Arrive by</span>
        <select
          value={stop.arriveMode}
          disabled={!canEdit}
          onChange={(e) => actions.onMode(e.target.value as ArriveMode)}
          className="bg-transparent text-xs font-medium text-ink focus:outline-none disabled:opacity-100"
          aria-label={`How you arrive in ${stop.city.name}`}
        >
          {ARRIVE_MODES.map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
      <div className="min-w-[9rem] flex-1">
        <BlurText
          value={stop.arriveNote ?? ""}
          onSave={actions.onArriveNote}
          disabled={!canEdit}
          placeholder={canEdit ? "Travel note (train number, time…)" : ""}
          aria-label={`Travel note for ${stop.city.name}`}
        />
      </div>
    </div>
  );

  const stepper = (
    <div className="flex items-center rounded-full border border-line" role="group" aria-label={`Nights in ${stop.city.name}`}>
      <button
        className="grid h-8 w-8 place-items-center rounded-full text-ink-soft hover:bg-paper-2 hover:text-ink disabled:opacity-30"
        onClick={() => actions.onNights(stop.nights - 1)}
        disabled={!canEdit || stop.nights <= 0}
        aria-label={`One fewer night in ${stop.city.name}`}
      >
        <MinusIcon />
      </button>
      <span className="inline-flex min-w-[4.75rem] items-center justify-center gap-1 whitespace-nowrap text-center font-mono text-sm font-semibold">
        {lock === "booked" ? <LockIcon className="h-3 w-3 text-ok" /> : null}
        <span data-testid="stop-nights">
          {stop.nights} night{stop.nights === 1 ? "" : "s"}
        </span>
      </span>
      <button
        className="grid h-8 w-8 place-items-center rounded-full text-ink-soft hover:bg-paper-2 hover:text-ink disabled:opacity-30"
        onClick={() => actions.onNights(stop.nights + 1)}
        disabled={!canEdit}
        aria-label={`One more night in ${stop.city.name}`}
      >
        <PlusIcon />
      </button>
    </div>
  );

  const grip = canEdit ? (
    <button
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label={`Drag to reorder ${stop.city.name}${lock === "booked" ? " (its hotel is booked for these dates)" : ""}`}
      title={lock === "booked" ? "Its hotel is booked for these dates. Moving it means changing the booking." : undefined}
      className="-ml-1 cursor-grab touch-none rounded p-1 text-ink-faint hover:bg-paper-2 hover:text-ink active:cursor-grabbing"
    >
      {lock === "booked" ? <LockIcon className="text-ok" /> : <GripIcon />}
    </button>
  ) : null;

  const shared = {
    ref: setNodeRef,
    id: `stop-${stop.id}`,
    "data-testid": "stop-card",
    "data-city": stop.city.code,
    "data-lock": lock,
    style: { transform: CSS.Transform.toString(transform), transition },
  };

  if (folded) {
    const bookedCount = stop.legs.filter((l) => l.status === "booked").length + stop.stays.filter((s) => s.status === "booked").length;
    return (
      <li {...shared} data-compact="true" className={`ticket flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 ${isDragging ? "z-10 opacity-90 shadow-2xl" : ""} ${broken ? "outline outline-1 outline-err" : ""}`}>
        <div className="flex items-center gap-1">
          {grip}
          <span className="font-mono text-[11px] text-ink-faint">{String(index + 1).padStart(2, "0")}</span>
        </div>
        <span className="text-[13px]" aria-hidden>
          <Flaps text={stop.city.code} />
        </span>
        <button onClick={() => setExpanded(true)} className="min-w-0 flex-1 text-left" aria-label={`Open ${stop.city.name}`}>
          <span className="block truncate text-sm font-semibold">{stop.city.name}</span>
          <span className="block font-mono text-xs text-ink-soft" data-testid="stop-dates">
            {dayDate(stop.arrive)} → {dayDate(stop.depart)}
          </span>
        </button>
        <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {issueCount ? <span className="rounded-full bg-err/10 px-2 py-0.5 font-medium text-err">{issueCount} to fix</span> : null}
          {broken ? <span className="rounded-full bg-err/10 px-2 py-0.5 font-medium text-err">Off booked dates</span> : null}
          {bookedCount ? <span className="rounded-full bg-ok/10 px-2 py-0.5 font-medium text-ok">{bookedCount} booked</span> : null}
          {pace && pace.level !== "empty" ? <PaceChip pace={pace} /> : null}
        </span>
        {stepper}
      </li>
    );
  }

  return (
    <li
      {...shared}
      className={`ticket grid scroll-mt-4 grid-cols-1 sm:grid-cols-[104px_minmax(0,1fr)] ${isDragging ? "z-10 opacity-90 shadow-2xl" : ""} ${broken ? "outline outline-1 outline-err" : ""}`}
    >
      {/* Stub: number, city code in split-flap tiles, city and country. */}
      <div className="flex items-center gap-3 border-b-2 border-dashed border-line px-3 py-2.5 sm:flex-col sm:items-start sm:gap-2 sm:border-b-0 sm:border-r-2 sm:px-3 sm:py-3.5">
        <div className="flex items-center gap-1">
          {grip}
          <span className="font-mono text-[11px] text-ink-faint">{String(index + 1).padStart(2, "0")}</span>
          {compact ? (
            <button onClick={() => setExpanded(false)} className="ml-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-sky hover:bg-sky/10" aria-label={`Fold ${stop.city.name}`}>
              Fold
            </button>
          ) : null}
        </div>
        <div className="text-[15px]" aria-hidden>
          <Flaps text={stop.city.code} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1 text-sm font-semibold leading-tight">
            <span className="truncate">{stop.city.name}</span>
            <MapsLink name={stop.city.name} near={stop.country.name} lat={stop.city.lat} lon={stop.city.lon} label="" />
          </div>
          <div className="flex items-center gap-1.5 text-xs text-ink-soft">
            <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: stop.country.color ?? "#5b616b" }} />
            <span className="truncate">{stop.country.name}</span>
          </div>
        </div>
        {canEdit ? (
          <div className="ml-auto flex items-center gap-0.5 sm:ml-0 sm:mt-auto">
            <button
              onClick={() => actions.onMove(-1)}
              disabled={index === 0}
              className="rounded p-1.5 text-ink-faint hover:bg-paper-2 hover:text-ink disabled:opacity-30"
              aria-label={`Move ${stop.city.name} earlier`}
            >
              <UpIcon />
            </button>
            <button
              onClick={() => actions.onMove(1)}
              disabled={index === count - 1}
              className="rounded p-1.5 text-ink-faint hover:bg-paper-2 hover:text-ink disabled:opacity-30"
              aria-label={`Move ${stop.city.name} later`}
            >
              <DownIcon />
            </button>
            <button
              onClick={actions.onRemove}
              className="rounded p-1.5 text-ink-faint hover:bg-err/10 hover:text-err"
              aria-label={`Remove ${stop.city.name}`}
            >
              <XIcon />
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-3.5 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="font-mono text-sm font-medium" data-testid="stop-dates">
            {dayDate(stop.arrive)} <span className="text-ink-faint">→</span> {dayDate(stop.depart)}
          </div>
          {stepper}
        </div>

        <PinRow pins={pins} lock={lock} />
        {trade}
        {issues}

        <section className="space-y-1.5" aria-label={`Getting to ${stop.city.name}`}>
          <SectionLabel>Getting here</SectionLabel>
          {getHere ? getHere(modeRow) : modeRow}
        </section>

        <section className="space-y-1.5" aria-label={`Plans in ${stop.city.name}`}>
          <div className="flex flex-wrap items-center gap-2">
            <SectionLabel>Plans</SectionLabel>
            {pace && pace.level !== "empty" ? <PaceChip pace={pace} /> : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {stop.planned.map((a) =>
              isFixedDate(a.when) ? (
                <span
                  key={a.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-stamp/40 bg-stamp/5 px-2.5 py-0.5 text-xs"
                >
                  <StarIcon className="h-3 w-3 shrink-0 text-stamp" />
                  <span className="truncate">{a.title}</span>
                  <span className="shrink-0 text-ink-soft">· {whenLabel(a.when)}</span>
                </span>
              ) : (
                <span key={a.id} className="inline-flex max-w-full items-center rounded-full border border-line bg-paper px-2.5 py-0.5 text-xs">
                  <span className="truncate">{a.title}</span>
                </span>
              ),
            )}
            <button
              onClick={actions.onOpenActivities}
              aria-label={`${stop.planned.length ? "Activities" : "Pick activities"}${libraryCount !== undefined ? ` (${libraryCount} in ${stop.city.name})` : ""}`}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-sky hover:bg-sky/10"
            >
              {stop.planned.length ? "Activities" : "Pick activities"}
              {libraryCount !== undefined ? <span className="font-mono text-ink-soft">· {libraryCount}</span> : null}
            </button>
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3 text-xs">
          <div className="min-w-0 flex-1">{stay}</div>
          {canEdit || hasCosts ? (
            <button
              onClick={() => setCostsOpen((o) => !o)}
              aria-expanded={costsOpen}
              className={`inline-flex items-center gap-1 font-medium ${hasCosts ? "text-ink" : "text-sky"} hover:underline`}
            >
              <span className="font-mono">{costSummary}</span>
              <DownIcon className={`h-3.5 w-3.5 transition-transform ${costsOpen ? "rotate-180" : ""}`} />
            </button>
          ) : null}
          {canEdit && !notesOpen ? (
            <button onClick={() => setNotesOpen(true)} className="font-medium text-sky hover:underline">
              Add a note
            </button>
          ) : null}
        </div>

        {costsOpen ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="stop-costs">
            <BlurMoney
              value={stop.stayCadPerNight}
              onSave={(v) => actions.onCosts({ stayCadPerNight: v })}
              disabled={!canEdit}
              label={`Stay in ${stop.city.name}, CAD per person per night`}
              suffix="/night stay"
            />
            <BlurMoney
              value={stop.arriveCostCad}
              onSave={(v) => actions.onCosts({ arriveCostCad: v })}
              disabled={!canEdit}
              label={`Getting to ${stop.city.name}, CAD per person`}
              suffix="to get here"
            />
            <span className="text-[11px] text-ink-faint">CAD per person</span>
          </div>
        ) : null}

        {notesOpen && (canEdit || stop.notes) ? (
          <BlurText
            value={stop.notes ?? ""}
            onSave={actions.onNotes}
            disabled={!canEdit}
            multiline
            placeholder={canEdit ? "Notes for the group" : ""}
            aria-label={`Notes for ${stop.city.name}`}
            className="text-ink-soft"
          />
        ) : null}
      </div>
    </li>
  );
}
