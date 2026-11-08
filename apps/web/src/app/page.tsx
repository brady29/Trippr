"use client";

import { shortDate } from "@trippr/rules";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BoardHeader, RequireAuth, TopBar } from "@/components/shell";
import { Button, ErrorNote, Input, Label, Spinner, Tag } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { keys, useTrips } from "@/lib/queries";

function NewTripForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const create = useMutation({
    mutationFn: () => api<{ id: string }>("/trips", { method: "POST", body: { name, startDate } }),
    onSuccess: ({ id }) => {
      void qc.invalidateQueries({ queryKey: keys.trips });
      router.push(`/trips/${id}`);
    },
  });
  return (
    <form
      className="grid gap-3 rounded-2xl border border-line bg-card p-4 sm:grid-cols-[1fr_auto_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div>
        <Label htmlFor="trip-name">New trip</Label>
        <Input id="trip-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Asia 2027" required />
      </div>
      <div>
        <Label htmlFor="trip-start">Starts</Label>
        <Input id="trip-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
      </div>
      <Button type="submit" variant="primary" disabled={create.isPending || !name || !startDate}>
        Create trip
      </Button>
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
  return (
    <>
      <BoardHeader eyebrow="Departures" title="My trips" meta={<span>Signed in as {me?.name}</span>} />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {trips.isPending ? <Spinner /> : null}
        {trips.error ? <ErrorNote error={trips.error} /> : null}
        {trips.data?.length === 0 ? (
          <p className="text-sm text-ink-soft">No trips yet. Create one below, or open an invite link from a friend.</p>
        ) : null}
        <ul className="grid gap-3 sm:grid-cols-2">
          {trips.data?.map((t) => (
            <li key={t.id}>
              <Link href={`/trips/${t.id}`} className="ticket flex items-center gap-4 p-4 hover:border-ink-faint">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lg font-semibold">{t.name}</div>
                  <div className="font-mono text-xs text-ink-soft">
                    From {shortDate(t.startDate)} {t.homeCity ? `· ${t.homeCity}` : ""} · {t.routeCount} route
                    {t.routeCount === 1 ? "" : "s"}
                  </div>
                </div>
                <Tag tone={t.role === "owner" ? "dark" : "plain"}>{t.role}</Tag>
              </Link>
            </li>
          ))}
        </ul>
        {!me?.isDemo ? <NewTripForm /> : null}
      </main>
    </>
  );
}

export default function Home() {
  return (
    <>
      <TopBar />
      <RequireAuth>
        <Trips />
      </RequireAuth>
    </>
  );
}
