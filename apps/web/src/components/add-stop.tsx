"use client";

import type { City, StopView } from "@trippr/contracts";
import { ARRIVE_MODES, type ArriveMode } from "@trippr/rules";
import { useEffect, useId, useState } from "react";
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

/** Add-stop search: pick a city, nights, how you get there and where it goes. */
export function AddStop({
  stops,
  pending,
  onAdd,
}: {
  stops: StopView[];
  pending: boolean;
  onAdd: (input: { cityCode: string; nights: number; arriveMode: ArriveMode; position: number }) => void;
}) {
  const listId = useId();
  const [q, setQ] = useState("");
  const [city, setCity] = useState<City | null>(null);
  const [open, setOpen] = useState(false);
  const [nights, setNights] = useState(2);
  const [mode, setMode] = useState<ArriveMode>("flight");
  const [position, setPosition] = useState<number>(-1);
  const search = useCitySearch(useDebounced(q.trim()));

  const submit = () => {
    if (!city) return;
    onAdd({ cityCode: city.code, nights, arriveMode: mode, position: position < 0 ? stops.length : position });
    setCity(null);
    setQ("");
  };

  return (
    <form
      className="rounded-2xl border border-dashed border-ink-faint/60 bg-card/60 p-3"
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
                    onClick={() => {
                      setCity(c);
                      setOpen(false);
                    }}
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
    </form>
  );
}
