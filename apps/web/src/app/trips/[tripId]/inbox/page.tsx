"use client";

import { hasRole, type InboxItem, type InboxResult, type InboxSuggestion, type StopView } from "@trippr/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { MapsLink } from "@/components/maps-link";
import { BoardHeader, BoardStat, RequireAuth, TopBar } from "@/components/shell";
import { useToast } from "@/components/toast";
import { TripNav } from "@/components/trip-nav";
import { Button, ErrorNote, Panel, Select, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatLegTime } from "@/lib/explorer";
import { keys, useRoute, useTrip } from "@/lib/queries";

const KIND_LABEL: Record<InboxItem["kind"], string> = { leg: "Ticket", stay: "Hotel", activity: "Idea", unknown: "Message" };
const STATUS: Record<InboxItem["status"], { label: string; style: string }> = {
  applied: { label: "Added", style: "bg-ok/15 text-ok" },
  pending: { label: "Waiting", style: "bg-warn/15 text-warn" },
  failed: { label: "Needs a look", style: "bg-err/15 text-err" },
  dismissed: { label: "Dismissed", style: "bg-paper-2 text-ink-faint" },
};
const MODE: Record<string, string> = { flight: "Flight", hsr: "High-speed train", train: "Train", road: "Bus or road", boat: "Boat" };
const money = (n: number | null | undefined) => (n == null ? null : `$${Math.round(n).toLocaleString()}`);
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function useInbox(tripId: string) {
  const ready = useAuth().status === "signedIn";
  return useQuery({
    queryKey: ["inbox", tripId],
    queryFn: () => api<InboxResult>(`/trips/${tripId}/inbox`),
    enabled: ready,
  });
}

function useInboxRefresh(tripId: string) {
  const qc = useQueryClient();
  return () => {
    for (const key of [["inbox", tripId], ["route"], ["bookings"], ["library"], ["trip-activities"], ["hotels"], ["areas"], ["graph"], keys.trip(tripId)]) {
      void qc.invalidateQueries({ queryKey: key });
    }
  };
}

function Details({ s, canSeePrivate }: { s: InboxSuggestion; canSeePrivate: boolean }) {
  const bits: (string | null)[] = [];
  if (s.kind === "leg") {
    bits.push(
      MODE[s.mode] ?? s.mode,
      [s.operator, s.number].filter(Boolean).join(" ") || null,
      s.departAt ? `Departs ${formatLegTime(s.departAt)}` : null,
      s.arriveAt ? `Arrives ${formatLegTime(s.arriveAt)}` : null,
      money(s.pricePerPersonCad) ? `${money(s.pricePerPersonCad)} pp` : null,
      canSeePrivate && s.bookingRef ? `Ref ${s.bookingRef}` : null,
      canSeePrivate && s.seat ? `Seat ${s.seat}` : null,
    );
  } else if (s.kind === "stay") {
    bits.push(
      s.areaName,
      s.checkIn && s.checkOut ? `${s.checkIn} → ${s.checkOut}` : null,
      s.rooms ? `${s.rooms} room${s.rooms === 1 ? "" : "s"}` : null,
      money(s.perNightCad) ? `${money(s.perNightCad)} a room a night` : null,
      canSeePrivate && s.bookingRef ? `Ref ${s.bookingRef}` : null,
    );
  } else {
    bits.push(s.tags.length ? s.tags.join(", ") : null, money(s.costCad));
  }
  const shown = bits.filter(Boolean);
  return (
    <>
      {shown.length ? <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-soft">{shown.map((b, i) => <span key={i}>{b}</span>)}</div> : null}
      {s.kind === "activity" && (s.note || s.url) ? (
        <div className="flex items-start gap-3 text-xs">
          {s.thumbnailUrl ? (
            <img src={s.thumbnailUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" referrerPolicy="no-referrer" />
          ) : null}
          <div className="min-w-0 space-y-0.5">
            {s.note ? <p className="text-ink-soft">{s.note}</p> : null}
            {s.url ? (
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="block truncate text-sky hover:underline">
                {s.url}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
      {s.kind === "stay" ? <MapsLink name={s.hotelName} near={s.areaName ?? undefined} className="text-xs" /> : null}
    </>
  );
}

function ItemCard({ item, tripId, stops, canSeePrivate }: { item: InboxItem; tripId: string; stops: StopView[]; canSeePrivate: boolean }) {
  const refresh = useInboxRefresh(tripId);
  const toast = useToast();
  const [stopId, setStopId] = useState(item.stopId ?? "");
  const [cityCode, setCityCode] = useState(item.suggestion?.kind === "activity" ? (item.suggestion.cityCode ?? "") : "");
  const accept = useMutation({
    mutationFn: () =>
      api<InboxItem>(`/inbox/${item.id}/accept`, {
        method: "POST",
        body: item.kind === "activity" ? (cityCode ? { cityCode } : {}) : stopId ? { stopId } : {},
      }),
    onSuccess: (updated) => {
      refresh();
      toast(updated.status === "applied" ? (updated.note ?? "Added") : (updated.note ?? "That didn't work"), updated.status === "applied" ? "ok" : "error");
    },
    onError: (e) => toast(e instanceof Error ? e.message : "That didn't work", "error"),
  });
  const dismiss = useMutation({
    mutationFn: () => api<InboxItem>(`/inbox/${item.id}/dismiss`, { method: "POST" }),
    onSuccess: refresh,
  });
  const open = item.status === "pending" || item.status === "failed";
  const cities = [...new Map(stops.map((s) => [s.city.code, s.city])).values()];
  const status = STATUS[item.status];

  return (
    <li className="ticket flex flex-col gap-2 p-3 sm:p-4" data-testid="inbox-item" data-status={item.status} data-kind={item.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-board px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber">{KIND_LABEL[item.kind]}</span>
        <span className="min-w-0 flex-1 font-semibold">{item.summary}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${status.style}`}>{status.label}</span>
      </div>
      {item.suggestion ? <Details s={item.suggestion} canSeePrivate={canSeePrivate} /> : null}
      {item.note ? <p className={`text-xs ${item.status === "failed" ? "text-err" : "text-ink-soft"}`}>{item.note}</p> : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
        <span>{item.source === "email" ? `Emailed by ${item.fromName ?? item.from ?? "someone"}` : `Pasted by ${item.fromName ?? "someone"}`}</span>
        {item.subject ? <span className="truncate">“{item.subject}”</span> : null}
        <span>{when(item.receivedAt)}</span>
        {item.stopLabel && item.status === "applied" ? <span>→ {item.stopLabel}</span> : null}
        {item.appliedBy && item.status === "applied" ? <span>added by {item.appliedBy}</span> : null}
      </div>
      {open && item.kind !== "unknown" ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {item.kind === "activity" ? (
            <Select aria-label="City for this idea" value={cityCode} onChange={(e) => setCityCode(e.target.value)} className="h-8 text-xs">
              <option value="">Pick a city</option>
              {cities.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
              {cityCode && !cities.some((c) => c.code === cityCode) ? <option value={cityCode}>{cityCode}</option> : null}
            </Select>
          ) : (
            <Select aria-label="Stop to add it to" value={stopId} onChange={(e) => setStopId(e.target.value)} className="h-8 text-xs">
              <option value="">Pick a stop</option>
              {stops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.order + 1}. {s.city.name} ({s.arrive})
                </option>
              ))}
            </Select>
          )}
          <Button
            onClick={() => accept.mutate()}
            disabled={accept.isPending || (item.kind === "activity" ? !cityCode : !stopId)}
            variant="primary"
            size="sm"
          >
            {accept.isPending ? "Adding…" : "Add to trip"}
          </Button>
          <button onClick={() => dismiss.mutate()} className="text-xs text-ink-soft hover:underline" disabled={dismiss.isPending}>
            Dismiss
          </button>
        </div>
      ) : open ? (
        <div className="pt-1">
          <button onClick={() => dismiss.mutate()} className="text-xs text-ink-soft hover:underline" disabled={dismiss.isPending}>
            Dismiss
          </button>
        </div>
      ) : null}
    </li>
  );
}

function PasteBox({ tripId }: { tripId: string }) {
  const [text, setText] = useState("");
  const refresh = useInboxRefresh(tripId);
  const toast = useToast();
  const paste = useMutation({
    mutationFn: () => api<InboxItem[]>(`/trips/${tripId}/inbox`, { method: "POST", body: { text } }),
    onSuccess: (items) => {
      setText("");
      refresh();
      const added = items.filter((i) => i.status === "applied").length;
      toast(added ? `Added ${added} thing${added === 1 ? "" : "s"} to the trip` : "Read it. Check the inbox below.", "ok");
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Couldn't read that", "error"),
  });
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) paste.mutate();
      }}
    >
      <label htmlFor="inbox-paste" className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">
        Paste a confirmation or a link
      </label>
      <textarea
        id="inbox-paste"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="Paste a booking confirmation email, a TikTok, Instagram or YouTube link, or a note like “Shibuya Sky in Tokyo looks amazing”."
        className="w-full rounded-xl border border-line bg-card px-3 py-2 text-sm outline-none focus:border-ink-faint"
      />
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={paste.isPending || !text.trim()}>
          {paste.isPending ? "Reading…" : "Read it"}
        </Button>
        <span className="text-xs text-ink-faint">Tickets and hotels go on the matching stop; ideas go into that city&apos;s activities.</span>
      </div>
    </form>
  );
}

function AddressPanel({ tripId, data, isOwner }: { tripId: string; data: InboxResult; isOwner: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rotate = useMutation({
    mutationFn: () => api<{ address: string | null }>(`/trips/${tripId}/inbox/address`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inbox", tripId] });
      toast("New address made. The old one no longer works.", "ok");
    },
  });
  return (
    <Panel title="Trip email address">
      {data.address ? (
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-paper-2 px-2 py-1 font-mono text-xs select-all" data-testid="inbox-address">
              {data.address}
            </code>
            <button
              className="text-xs font-medium text-sky hover:underline"
              onClick={() => void navigator.clipboard?.writeText(data.address!).then(() => toast("Copied", "ok"))}
            >
              Copy
            </button>
          </div>
          <p className="text-xs text-ink-soft">
            Forward booking confirmations here, or send links to TikToks, Reels and YouTube videos. Mail from the email address on your Trippr account is
            added straight away; anything else waits here for an editor.
          </p>
          {isOwner ? (
            <button
              className="text-xs text-ink-soft hover:underline"
              onClick={() => window.confirm("Make a new address? The current one will stop working.") && rotate.mutate()}
            >
              Make a new address
            </button>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-ink-soft">Email isn&apos;t set up on this deployment yet. Paste confirmations and links on the left instead.</p>
      )}
      <p className="mt-3 border-t border-line pt-2 text-xs text-ink-faint">
        {data.reader === "claude"
          ? "Claude reads each message for tickets, hotels and places to go."
          : "Links are turned into activity ideas. Reading tickets and hotels from confirmations needs Claude to be set up."}
      </p>
    </Panel>
  );
}

function CurrentStops({ routeId, children }: { routeId: string; children: (stops: StopView[]) => React.ReactNode }) {
  const route = useRoute(routeId);
  return <>{children(route.data?.stops ?? [])}</>;
}

function Inbox({ tripId }: { tripId: string }) {
  const trip = useTrip(tripId);
  const canEdit = trip.data ? hasRole(trip.data.role, "editor") : false;
  const q = useInbox(tripId);
  const items = q.data?.items ?? [];
  const waiting = items.filter((i) => i.status === "pending" || i.status === "failed");
  const done = items.filter((i) => i.status === "applied" || i.status === "dismissed");
  const currentRouteId = trip.data?.routes.find((r) => r.isCurrent)?.id ?? trip.data?.routes[0]?.id;

  if (trip.data && !canEdit) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10 text-center text-sm text-ink-soft">
        The inbox is for editors: it holds the booking emails people forward. Ask the trip owner to make you an editor.
      </main>
    );
  }

  const list = (stops: StopView[], group: InboxItem[]) => (
    <ol className="space-y-3">
      {group.map((i) => (
        <ItemCard key={i.id} item={i} tripId={tripId} stops={stops} canSeePrivate={q.data?.canSeePrivate ?? false} />
      ))}
    </ol>
  );

  const body = (stops: StopView[]) => (
    <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="space-y-6">
        <PasteBox tripId={tripId} />
        {q.isPending ? <Spinner /> : null}
        {q.error ? <ErrorNote error={q.error} /> : null}
        {q.data ? (
          <>
            <div>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">Waiting ({waiting.length})</h2>
              {waiting.length ? (
                list(stops, waiting)
              ) : (
                <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-ink-soft">Nothing waiting. New messages show up here.</p>
              )}
            </div>
            {done.length ? (
              <div>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">Done</h2>
                {list(stops, done)}
              </div>
            ) : null}
          </>
        ) : null}
      </section>
      <aside className="space-y-4">{q.data ? <AddressPanel tripId={tripId} data={q.data} isOwner={trip.data?.role === "owner"} /> : null}</aside>
    </main>
  );

  return (
    <>
      <BoardHeader
        eyebrow={`${trip.data?.trip.name ?? "Trip"} · inbox`}
        title="Inbox"
        meta={
          q.data ? (
            <>
              <BoardStat label="Waiting" value={waiting.length} />
              <BoardStat label="Added" value={items.filter((i) => i.status === "applied").length} />
              <BoardStat label="Reader" value={q.data.reader === "claude" ? "Claude" : "Links only"} />
            </>
          ) : null
        }
      />
      {currentRouteId ? <CurrentStops routeId={currentRouteId}>{body}</CurrentStops> : body([])}
    </>
  );
}

export default function InboxPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const trip = useTrip(tripId);
  return (
    <>
      <TopBar>
        <TripNav tripId={tripId} tripName={trip.data?.trip.name} />
      </TopBar>
      <RequireAuth>
        <Inbox tripId={tripId} />
      </RequireAuth>
    </>
  );
}
