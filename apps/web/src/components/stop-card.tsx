"use client";

import type React from "react";

import type { StopView } from "@trippr/contracts";
import { ARRIVE_MODES, dayDate, isFixedDate, whenLabel, type ArriveMode } from "@trippr/rules";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useState } from "react";
import { MapsLink } from "./maps-link";
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
    <label className="flex items-center gap-1 rounded-md bg-paper px-2 py-1 text-xs text-ink-soft">
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

export function StopCard({
  stop,
  index,
  count,
  canEdit,
  libraryCount,
  actions,
  children,
}: {
  stop: StopView;
  index: number;
  count: number;
  canEdit: boolean;
  libraryCount?: number;
  actions: StopCardActions;
  /** Extra sections inside the card body (legs, stays). */
  children?: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: stop.id,
    disabled: !canEdit,
  });

  return (
    <li
      ref={setNodeRef}
      id={`stop-${stop.id}`}
      data-testid="stop-card"
      data-city={stop.city.code}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`ticket flex flex-col sm:flex-row ${isDragging ? "z-10 opacity-90 shadow-2xl" : ""}`}
    >
      {/* Stub: the city code, like a boarding pass. */}
      <div className="flex items-center gap-3 p-3 sm:w-40 sm:flex-col sm:items-start sm:justify-between sm:p-4">
        <div className="flex items-center gap-2 sm:w-full sm:justify-between">
          {canEdit ? (
            <button
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              aria-label={`Drag to reorder ${stop.city.name}`}
              className="cursor-grab touch-none rounded p-1 text-ink-faint hover:bg-paper-2 hover:text-ink active:cursor-grabbing"
            >
              <GripIcon />
            </button>
          ) : null}
          <span className="font-mono text-[11px] text-ink-faint">#{index + 1}</span>
        </div>
        <div className="min-w-0">
          <div className="font-mono text-3xl font-semibold leading-none tracking-tight" aria-hidden>
            {stop.city.code}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{stop.city.name}</span>
            <MapsLink name={stop.city.name} near={stop.country.name} lat={stop.city.lat} lon={stop.city.lon} label="" />
          </div>
          <div className="flex items-center gap-1.5 text-xs text-ink-soft">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: stop.country.color ?? "#59626e" }} />
            {stop.country.name}
          </div>
        </div>
      </div>

      <div className="ticket-perf flex min-w-0 flex-1 flex-col gap-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="font-mono text-sm" data-testid="stop-dates">
            {dayDate(stop.arrive)} <span className="text-ink-faint">→</span> {dayDate(stop.depart)}
          </div>
          <div className="flex items-center gap-1" role="group" aria-label={`Nights in ${stop.city.name}`}>
            <button
              className="grid h-8 w-8 place-items-center rounded-md border border-line hover:border-ink-faint disabled:opacity-40"
              onClick={() => actions.onNights(stop.nights - 1)}
              disabled={!canEdit || stop.nights <= 0}
              aria-label={`One fewer night in ${stop.city.name}`}
            >
              <MinusIcon />
            </button>
            <span className="w-20 whitespace-nowrap text-center font-mono text-sm" data-testid="stop-nights">
              {stop.nights} night{stop.nights === 1 ? "" : "s"}
            </span>
            <button
              className="grid h-8 w-8 place-items-center rounded-md border border-line hover:border-ink-faint disabled:opacity-40"
              onClick={() => actions.onNights(stop.nights + 1)}
              disabled={!canEdit}
              aria-label={`One more night in ${stop.city.name}`}
            >
              <PlusIcon />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 rounded-md bg-paper px-2 py-1 text-xs text-ink-soft">
            <ModeIcon mode={stop.arriveMode} className={stop.arriveMode === "flight" ? "text-sky" : "text-rail"} />
            <span className="sr-only">Arrive by</span>
            <select
              value={stop.arriveMode}
              disabled={!canEdit}
              onChange={(e) => actions.onMode(e.target.value as ArriveMode)}
              className="bg-transparent text-xs font-medium text-ink focus:outline-none"
              aria-label={`How you arrive in ${stop.city.name}`}
            >
              {ARRIVE_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
          <div className="min-w-[10rem] flex-1">
            <BlurText
              value={stop.arriveNote ?? ""}
              onSave={actions.onArriveNote}
              disabled={!canEdit}
              placeholder={canEdit ? "Travel note (train number, time…)" : ""}
              aria-label={`Travel note for ${stop.city.name}`}
            />
          </div>
        </div>

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
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {stop.planned.map((a) => (
            <span
              key={a.id}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-paper px-2 py-0.5 text-xs"
            >
              {isFixedDate(a.when) ? <StarIcon className="h-3 w-3 text-stamp" /> : null}
              <span className="truncate">{a.title}</span>
              {isFixedDate(a.when) ? <span className="text-ink-faint">· {whenLabel(a.when)}</span> : null}
            </span>
          ))}
          <button
            onClick={actions.onOpenActivities}
            className="rounded-full px-2 py-0.5 text-xs font-medium text-sky hover:bg-sky/10"
          >
            {stop.planned.length ? "Activities" : "Pick activities"}
            {libraryCount !== undefined ? ` (${libraryCount} in ${stop.city.name})` : ""}
          </button>
        </div>

        {children}

        <BlurText
          value={stop.notes ?? ""}
          onSave={actions.onNotes}
          disabled={!canEdit}
          multiline
          placeholder={canEdit ? "Notes" : ""}
          aria-label={`Notes for ${stop.city.name}`}
          className="text-ink-soft"
        />
      </div>

      {canEdit ? (
        <div className="flex items-center justify-end gap-1 border-t border-dashed border-line p-2 sm:flex-col sm:justify-center sm:border-l sm:border-t-0">
          <button
            onClick={() => actions.onMove(-1)}
            disabled={index === 0}
            className="rounded p-1.5 text-ink-soft hover:bg-paper-2 disabled:opacity-30"
            aria-label={`Move ${stop.city.name} earlier`}
          >
            <UpIcon />
          </button>
          <button
            onClick={() => actions.onMove(1)}
            disabled={index === count - 1}
            className="rounded p-1.5 text-ink-soft hover:bg-paper-2 disabled:opacity-30"
            aria-label={`Move ${stop.city.name} later`}
          >
            <DownIcon />
          </button>
          <button
            onClick={actions.onRemove}
            className="rounded p-1.5 text-ink-soft hover:bg-err/10 hover:text-err"
            aria-label={`Remove ${stop.city.name}`}
          >
            <XIcon />
          </button>
        </div>
      ) : null}
    </li>
  );
}
