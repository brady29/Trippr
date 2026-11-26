"use client";

import type { City, TripListItem } from "@trippr/contracts";
import { daysBetween, shortDate } from "@trippr/rules";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { DownIcon } from "@/components/icons";
import { BoardHeader, Flaps, RequireAuth } from "@/components/shell";
import { Button, ErrorNote, Input, Label, Spinner, Tag } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { keys, useCitySearch, useTrips } from "@/lib/queries";
import { routeHref, tripTile } from "@/lib/routes";

const today = () => new Date().toLocaleDateString("en-CA");

/** "Departs in 166 days", "Departs tomorrow", "Underway". */
function departure(startDate: string): { big: string; small: string } {
  const days = daysBetween(today(), startDate);
  if (days > 1) return { big: String(days), small: "days to go" };
  if (days === 1) return { big: "1", small: "day to go" };
  if (days === 0) return { big: "Today", small: "departs" };
  return { big: "On", small: "the road" };
}

function TripRow({ trip }: { trip: TripListItem }) {
  const d = departure(trip.startDate);
  return (
    <li>
      <Link
        href={`/trips/${trip.id}`}
        className="ticket group grid grid-cols-[minmax(0,1fr)_auto] items-stretch hover:border-ink-faint sm:grid-cols-[auto_minmax(0,1fr)_auto]"
        data-testid="trip-row"
      >
        <div className="hidden place-items-center border-r-2 border-dashed border-line px-4 sm:grid">
          <span className="text-base" aria-hidden>
            <Flaps text={tripTile(trip.name)} />
          </span>
        </div>
        <div className="min-w-0 px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-lg font-semibold group-hover:underline">{trip.name}</span>
            <Tag tone={trip.role === "owner" ? "dark" : "plain"}>{trip.role}</Tag>
          </div>
          <div className="mt-0.5 font-mono text-xs text-ink-soft">
            Departs {shortDate(trip.startDate)}
            {trip.homeCity ? ` from ${trip.homeCity}` : ""} · {trip.routeCount} route{trip.routeCount === 1 ? "" : "s"}
          </div>
        </div>
        <div className="flex flex-col items-end justify-center border-l-2 border-dashed border-line px-4 py-3 text-right">
          <span className="font-mono text-2xl font-semibold leading-none">{d.big}</span>
          <span className="mt-1 text-[10px] uppercase tracking-[0.16em] text-ink-faint">{d.small}</span>
        </div>
      </Link>
    </li>
  );
}

/** A city search that fills in a code. */
function CityField({ id, label, value, onChange, placeholder }: { id: string; label: string; value: City | null; onChange: (c: City | null) => void; placeholder: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const search = useCitySearch(q.trim());
  return (
    <div className="relative">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        value={value ? `${value.name} (${value.code})` : q}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(null);
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && !value && q.trim() && search.data?.length ? (
        <ul role="listbox" className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-card py-1 shadow-lg">
          {search.data.map((c) => (
            <li key={c.code}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-paper"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(c);
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
  );
}

type MustDoRow = { key: number; city: City | null; title: string; from: string; to: string };

/**
 * Trip setup: the dates as a range (start, and the latest you can be home),
 * who's going, where from, and the must-dos with fixed dates. With must-dos,
 * Trippr drafts the first route around them.
 */
function NewTripForm({ startOpen }: { startOpen: boolean }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(startOpen);
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [latestReturn, setLatestReturn] = useState("");
  const [travellers, setTravellers] = useState(2);
  const [homeCity, setHomeCity] = useState("");
  const [mustDos, setMustDos] = useState<MustDoRow[]>([]);
  const nextKey = useRef(1);
  const ready = mustDos.filter((m) => m.city && m.title.trim() && m.from);
  const nights = startDate && latestReturn && latestReturn > startDate ? daysBetween(startDate, latestReturn) : null;
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; routeId: string; missed: { title: string }[] }>("/trips", {
        method: "POST",
        body: {
          name,
          startDate,
          travellers,
          ...(homeCity.trim() ? { homeCity: homeCity.trim() } : {}),
          ...(latestReturn ? { latestReturn } : {}),
          ...(ready.length ? { mustDos: ready.map((m) => ({ cityCode: m.city!.code, title: m.title.trim(), from: m.from, to: m.to && m.to >= m.from ? m.to : m.from })) } : {}),
        },
      }),
    onSuccess: ({ id, routeId }) => {
      void qc.invalidateQueries({ queryKey: keys.trips });
      router.push(ready.length ? routeHref(id, routeId) : `/trips/${id}`);
    },
  });
  const update = (key: number, patch: Partial<MustDoRow>) => setMustDos((list) => list.map((m) => (m.key === key ? { ...m, ...patch } : m)));

  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)} aria-expanded={false}>
        Plan a new trip
      </Button>
    );
  }
  return (
    <form
      className="space-y-5 rounded-2xl border border-line bg-card p-4 sm:p-5"
      aria-label="Plan a new trip"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
        <div>
          <Label htmlFor="trip-name">Trip name</Label>
          <Input id="trip-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Asia 2027" required autoFocus={!startOpen} />
        </div>
        <div>
          <Label htmlFor="trip-travellers">Travellers</Label>
          <Input id="trip-travellers" type="number" min={1} max={20} value={travellers} onChange={(e) => setTravellers(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">When</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="trip-start">Starts</Label>
            <Input id="trip-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="trip-latest">Home by (optional)</Label>
            <Input id="trip-latest" type="date" value={latestReturn} min={startDate || undefined} onChange={(e) => setLatestReturn(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="trip-home">Flying from (optional)</Label>
            <Input id="trip-home" value={homeCity} onChange={(e) => setHomeCity(e.target.value)} placeholder="Toronto" />
          </div>
        </div>
        <p className="text-xs text-ink-faint">
          {nights ? `Up to ${nights} nights. Routes that run past ${shortDate(latestReturn)} get a check with ways to fix it.` : "Set a home-by date if the trip has to end by a certain day."}
        </p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">Must-dos (optional)</legend>
        <p className="text-xs text-ink-faint">Things on a fixed date you&apos;re building the trip around: a festival, a match, a wedding. Trippr drafts the first route so you&apos;re in each city for them.</p>
        <ul className="space-y-2" data-testid="must-dos">
          {mustDos.map((m, i) => (
            <li key={m.key} className="grid gap-2 rounded-xl bg-paper p-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_8.5rem_8.5rem_auto] sm:items-end">
              <CityField id={`must-city-${m.key}`} label="City" value={m.city} onChange={(city) => update(m.key, { city })} placeholder="Kyoto" />
              <div>
                <Label htmlFor={`must-title-${m.key}`}>What</Label>
                <Input id={`must-title-${m.key}`} value={m.title} onChange={(e) => update(m.key, { title: e.target.value })} placeholder="Aoi Matsuri" />
              </div>
              <div>
                <Label htmlFor={`must-from-${m.key}`}>On</Label>
                <Input id={`must-from-${m.key}`} type="date" value={m.from} min={startDate || undefined} onChange={(e) => update(m.key, { from: e.target.value })} />
              </div>
              <div>
                <Label htmlFor={`must-to-${m.key}`}>Until (optional)</Label>
                <Input id={`must-to-${m.key}`} type="date" value={m.to} min={m.from || undefined} onChange={(e) => update(m.key, { to: e.target.value })} />
              </div>
              <Button variant="ghost" size="sm" onClick={() => setMustDos((list) => list.filter((x) => x.key !== m.key))} aria-label={`Remove must-do ${i + 1}`}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <Button size="sm" onClick={() => setMustDos((list) => [...list, { key: nextKey.current++, city: null, title: "", from: "", to: "" }])} disabled={mustDos.length >= 12}>
          Add a must-do
        </Button>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button type="submit" variant="primary" disabled={create.isPending || !name || !startDate}>
          {ready.length ? `Create trip and draft a route (${ready.length} must-do${ready.length === 1 ? "" : "s"})` : "Create trip"}
        </Button>
        {!startOpen ? (
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        ) : null}
      </div>
      {create.error ? <ErrorNote error={create.error} /> : null}
    </form>
  );
}

function Trips() {
  const { me } = useAuth();
  const trips = useTrips();
  const list = [...(trips.data ?? [])].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const empty = trips.data?.length === 0;
  return (
    <>
      <BoardHeader eyebrow="Departures" title="My trips" width="max-w-3xl" meta={<span className="text-amber-soft/80">Signed in as {me?.name}</span>} />
      <main className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:px-6">
        {trips.isPending ? <Spinner /> : null}
        {trips.error ? <ErrorNote error={trips.error} /> : null}
        {empty ? (
          <div className="rounded-2xl border border-dashed border-line bg-card px-5 py-8 text-center">
            <p className="font-semibold">No trips yet</p>
            <p className="mt-1 text-sm text-ink-soft">Plan one below, or open an invite link a friend sent you.</p>
          </div>
        ) : null}
        {list.length ? (
          <section aria-label="Your trips" className="space-y-2.5">
            <div className="flex items-center justify-between px-1 text-[10px] uppercase tracking-[0.18em] text-ink-faint">
              <span>Trip</span>
              <span className="flex items-center gap-1">
                Soonest first <DownIcon className="h-3 w-3" />
              </span>
            </div>
            <ul className="space-y-2.5">
              {list.map((t) => (
                <TripRow key={t.id} trip={t} />
              ))}
            </ul>
          </section>
        ) : null}
        {!me?.isDemo && trips.data ? <NewTripForm startOpen={empty} /> : null}
      </main>
    </>
  );
}

export default function Home() {
  return (
    <RequireAuth>
      <Trips />
    </RequireAuth>
  );
}
