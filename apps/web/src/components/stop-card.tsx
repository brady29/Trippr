"use client";

import type React from "react";

import type { StopView } from "@trippr/contracts";
import { ARRIVE_MODES, dayDate, isFixedDate, whenLabel, type ArriveMode } from "@trippr/rules";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useState } from "react";
import { MapsLink } from "./maps-link";
import { Flaps } from "./shell";
import { DownIcon, GripIcon, MinusIcon, ModeIcon, PlusIcon, StarIcon, UpIcon, XIcon } from "./icons";

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
}) {
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

  return (
    <li
      ref={setNodeRef}
      id={`stop-${stop.id}`}
      data-testid="stop-card"
      data-city={stop.city.code}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`ticket grid scroll-mt-4 grid-cols-1 sm:grid-cols-[104px_minmax(0,1fr)] ${isDragging ? "z-10 opacity-90 shadow-2xl" : ""}`}
    >
      {/* Stub: number, city code in split-flap tiles, city and country. */}
      <div className="flex items-center gap-3 border-b-2 border-dashed border-line px-3 py-2.5 sm:flex-col sm:items-start sm:gap-2 sm:border-b-0 sm:border-r-2 sm:px-3 sm:py-3.5">
        <div className="flex items-center gap-1">
          {canEdit ? (
            <button
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              aria-label={`Drag to reorder ${stop.city.name}`}
              className="-ml-1 cursor-grab touch-none rounded p-1 text-ink-faint hover:bg-paper-2 hover:text-ink active:cursor-grabbing"
            >
              <GripIcon />
            </button>
          ) : null}
          <span className="font-mono text-[11px] text-ink-faint">{String(index + 1).padStart(2, "0")}</span>
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
          <div className="flex items-center rounded-full border border-line" role="group" aria-label={`Nights in ${stop.city.name}`}>
            <button
              className="grid h-8 w-8 place-items-center rounded-full text-ink-soft hover:bg-paper-2 hover:text-ink disabled:opacity-30"
              onClick={() => actions.onNights(stop.nights - 1)}
              disabled={!canEdit || stop.nights <= 0}
              aria-label={`One fewer night in ${stop.city.name}`}
            >
              <MinusIcon />
            </button>
            <span className="min-w-[4.75rem] whitespace-nowrap text-center font-mono text-sm font-semibold" data-testid="stop-nights">
              {stop.nights} night{stop.nights === 1 ? "" : "s"}
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
        </div>

        <section className="space-y-1.5" aria-label={`Getting to ${stop.city.name}`}>
          <SectionLabel>Getting here</SectionLabel>
          {getHere ? getHere(modeRow) : modeRow}
        </section>

        <section className="space-y-1.5" aria-label={`Plans in ${stop.city.name}`}>
          <SectionLabel>Plans</SectionLabel>
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
