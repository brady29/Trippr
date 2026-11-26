"use client";

import type { TripListItem } from "@trippr/contracts";
import { daysBetween, shortDate } from "@trippr/rules";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DownIcon } from "@/components/icons";
import { BoardHeader, Flaps, RequireAuth } from "@/components/shell";
import { Button, ErrorNote, Input, Label, Spinner, Tag } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { keys, useTrips } from "@/lib/queries";
import { tripTile } from "@/lib/routes";

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

function NewTripForm({ startOpen }: { startOpen: boolean }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(startOpen);
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const create = useMutation({
    mutationFn: () => api<{ id: string }>("/trips", { method: "POST", body: { name, startDate } }),
    onSuccess: ({ id }) => {
      void qc.invalidateQueries({ queryKey: keys.trips });
      router.push(`/trips/${id}`);
    },
  });
  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)} aria-expanded={false}>
        Plan a new trip
      </Button>
    );
  }
  return (
    <form
      className="grid gap-3 rounded-2xl border border-line bg-card p-4 sm:grid-cols-[1fr_auto_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div>
        <Label htmlFor="trip-name">Trip name</Label>
        <Input id="trip-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Asia 2027" required autoFocus={!startOpen} />
      </div>
      <div>
        <Label htmlFor="trip-start">Starts</Label>
        <Input id="trip-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={create.isPending || !name || !startDate}>
          Create trip
        </Button>
        {!startOpen ? (
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        ) : null}
      </div>
      {create.error ? (
        <div className="sm:col-span-3">
          <ErrorNote error={create.error} />
        </div>
      ) : null}
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
