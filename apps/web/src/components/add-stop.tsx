"use client";

import type { City, StopView } from "@trippr/contracts";
import {
  ARRIVE_MODES,
  bestInsertion,
  bookingNames,
  listNames,
  shortDate,
  suggestedNights,
  type ArriveMode,
  type InsertPlan,
  type NightsChange,
} from "@trippr/rules";
import { useEffect, useId, useMemo, useState } from "react";
import { useCitySearch } from "@/lib/queries";
import { MODE_LABEL } from "./stop-card";
import { Button, Input, Select } from "./ui";

function useDebounced<T>(value: T, ms = 200) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const km = (n: number) => `${n.toLocaleString("en-CA")} km`;

/**
 * Add-stop search: pick a city, and Trippr suggests where it fits on the map
 * (the least backtracking) and how many nights, then shows what adding it
 * does to the dates and bookings before anything is saved.
 */
export function AddStop({
  stops,
  pending,
  plan,
  onAdd,
}: {
  stops: StopView[];
  pending: boolean;
  /** What adding this city at this position does to the bookings (from the rules engine). */
  plan: (city: City, nights: number, position: number) => InsertPlan;
  onAdd: (input: { cityCode: string; nights: number; arriveMode: ArriveMode; position: number }, trade?: NightsChange[]) => void;
}) {
  const listId = useId();
  const [q, setQ] = useState("");
  const [city, setCity] = useState<City | null>(null);
  const [open, setOpen] = useState(false);
  const [nights, setNights] = useState(2);
  const [mode, setMode] = useState<ArriveMode>("flight");
  const [position, setPosition] = useState<number>(-1);
  const [choice, setChoice] = useState<number>(0);
  const search = useCitySearch(useDebounced(q.trim()));

  const fit = useMemo(() => (city ? bestInsertion(stops.map((s) => ({ lat: s.city.lat, lon: s.city.lon })), city) : null), [city, stops]);
  const at = position < 0 ? stops.length : position;
  const preview = useMemo(() => (city ? plan(city, nights, at) : null), [city, nights, at, plan]);
  const name = (i: number) => stops[i]?.city.name;
  const where = (p: number) => (p === 0 ? (stops.length ? `before ${name(0)}` : "as the first stop") : p >= stops.length ? `after ${name(stops.length - 1)}, at the end` : `between ${name(p - 1)} and ${name(p)}`);

  const pick = (c: City) => {
    setCity(c);
    setOpen(false);
    const f = bestInsertion(stops.map((s) => ({ lat: s.city.lat, lon: s.city.lon })), c);
    setPosition(f.position >= stops.length ? -1 : f.position);
    setNights(suggestedNights(f));
    setChoice(0);
  };

  const submit = () => {
    if (!city) return;
    const trade = preview?.impact.breaks.length ? preview.trades[choice]?.changes : undefined;
    onAdd({ cityCode: city.code, nights, arriveMode: mode, position: at }, trade);
    setCity(null);
    setQ("");
    setPosition(-1);
  };

  return (
    <form
      className="space-y-2.5 rounded-2xl border border-dashed border-ink-faint/60 bg-card/60 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1.6fr)_5rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <div className="relative">
          <Input
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-label="Search for a city to add"
            placeholder="Add a stop: search a city or code"
            value={city ? `${city.name} (${city.code})` : q}
            onChange={(e) => {
              setCity(null);
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          />
          {open && !city && search.data?.length ? (
            <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-line bg-card py-1 shadow-lg">
              {search.data.map((c) => (
                <li key={c.code}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-paper"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(c)}
                  >
                    <span className="w-10 font-mono text-xs font-semibold">{c.code}</span>
                    <span className="flex-1">{c.name}</span>
                    <span className="text-xs text-ink-faint">{c.countryName}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <Input
          type="number"
          min={0}
          max={120}
          value={nights}
          onChange={(e) => setNights(Math.max(0, Number(e.target.value) || 0))}
          aria-label="Nights"
        />
        <Select value={mode} onChange={(e) => setMode(e.target.value as ArriveMode)} aria-label="Arrive by">
          {ARRIVE_MODES.map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </Select>
        <Select value={position} onChange={(e) => setPosition(Number(e.target.value))} aria-label="Position">
          <option value={-1}>At the end</option>
          {stops.map((s, i) => (
            <option key={s.id} value={i}>
              Before {s.city.name}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary" disabled={!city || pending}>
          Add stop
        </Button>
      </div>

      {city && fit && preview ? (
        <div className="space-y-2 rounded-xl bg-paper p-3 text-xs" data-testid="add-preview">
          <p className="text-ink">
            {fit.position === at ? (
              <>
                <span className="font-semibold">Fits best {where(at)}</span>
                {stops.length ? (
                  <span className="text-ink-soft">
                    {" "}
                    · {fit.addedKm < 25 ? "it's on the way, so it adds almost no travel" : `adds about ${km(fit.addedKm)} of travel`}
                    {fit.position < stops.length ? ` (at the end it would add ${km(fit.atEndKm)})` : ""}
                  </span>
                ) : null}
              </>
            ) : (
              <>
                <span className="font-semibold">Adding it {where(at)}.</span>{" "}
                <button type="button" className="font-medium text-sky hover:underline" onClick={() => setPosition(fit.position >= stops.length ? -1 : fit.position)}>
                  It fits best {where(fit.position)}
                </button>
              </>
            )}
          </p>
          {fit.nearest && fit.nearest.km < 80 ? (
            <p className="text-ink-soft">
              {city.name} is about {km(fit.nearest.km)} from {name(fit.nearest.index)}, so 1 night is suggested; a day trip from there could work too.
            </p>
          ) : null}
          {preview.impact.breaks.length ? (
            <div className="space-y-1.5" role="radiogroup" aria-label="How to fit it in">
              <p className="font-medium text-err">
                {nights} night{nights === 1 ? "" : "s"} here would move {listNames(bookingNames(preview.impact.breaks))} off {bookingNames(preview.impact.breaks).length === 1 ? "its" : "their"} booked dates.
              </p>
              {preview.trades.map((t, i) => {
                const other = stops.find((s) => s.id === t.withStopId)!;
                return (
                  <label key={t.withStopId} className="flex cursor-pointer items-center gap-2" data-testid="add-trade">
                    <input type="radio" name="add-choice" checked={choice === i} onChange={() => setChoice(i)} className="accent-accent" />
                    Take {nights === 1 ? "the night" : `the ${nights} nights`} from {other.city.name} ({other.nights} → {other.nights - nights}). No bookings move.
                  </label>
                );
              })}
              <label className="flex cursor-pointer items-center gap-2 text-err">
                <input type="radio" name="add-choice" checked={choice === preview.trades.length} onChange={() => setChoice(preview.trades.length)} className="accent-accent" />
                Add it anyway and move the dates
              </label>
            </div>
          ) : (
            <p className="text-ink-soft" data-testid="add-impact">
              {preview.impact.homeBefore !== preview.impact.homeAfter ? `Home moves from ${shortDate(preview.impact.homeBefore)} to ${shortDate(preview.impact.homeAfter)}. ` : ""}
              No bookings move.
            </p>
          )}
        </div>
      ) : null}
    </form>
  );
}
