"use client";

import { hasRole, type City, type InboxItem, type InboxResult, type InboxSuggestion, type StopView } from "@trippr/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { MapsLink } from "@/components/maps-link";
import { PlaceLinks } from "@/components/place-links";
import { BoardHeader, BoardStat, RequireAuth } from "@/components/shell";
import { useToast } from "@/components/toast";
import { Button, ErrorNote, Select, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatLegTime } from "@/lib/explorer";
import { keys, useRoute, useTrip } from "@/lib/queries";
import { routeHref } from "@/lib/routes";

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

/** The links the place lookup found for an idea, as the activity will show them. */
function FoundLinks({ s, cities }: { s: Extract<InboxSuggestion, { kind: "activity" }>; cities: Map<string, City> }) {
  const p = s.place;
  if (!p) return null;
  const city = s.cityCode ? cities.get(s.cityCode) : undefined;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <PlaceLinks
        activity={{
          title: p.placeName || s.title,
          cityName: city?.name ?? s.cityCode ?? "",
          countryIso: city?.countryIso ?? null,
          address: p.address,
          lat: p.lat,
          lon: p.lon,
          url: s.url,
          website: p.website,
          ticketUrl: p.ticketUrl,
          reserveUrl: p.reserveUrl,
          mapsUrl: p.mapsUrl,
        }}
      />
      {p.placeStatus === "check" ? <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-semibold text-warn">Check the pin</span> : null}
      {p.placeStatus === "not_found" ? <span className="text-ink-faint">Not on the map yet</span> : null}
    </div>
  );
}

/** "Finding the place…" while the lookup runs; "Couldn't find the place" with a retry when it gave up. */
function LookupState({ item, tripId }: { item: InboxItem; tripId: string }) {
  const refresh = useInboxRefresh(tripId);
  const toast = useToast();
  const retry = useMutation({
    mutationFn: () => api<InboxItem>(`/inbox/${item.id}/lookup`, { method: "POST" }),
    onSuccess: (updated) => {
      refresh();
      toast(updated.lookup === "done" ? "Found it" : "Still couldn't find the place", updated.lookup === "done" ? "ok" : "error");
    },
    onError: (e) => toast(e instanceof Error ? e.message : "That didn't work", "error"),
  });
  if (item.lookup === "pending" || retry.isPending) return <Spinner label="Finding the place…" />;
  if (item.lookup !== "failed" || item.status === "dismissed") return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-ink-soft" data-testid="inbox-lookup-failed">
      <span>Couldn&apos;t find the place.</span>
      <button onClick={() => retry.mutate()} className="font-medium text-sky hover:underline">
        Try again
      </button>
    </p>
  );
}

function Details({ s, canSeePrivate, cities }: { s: InboxSuggestion; canSeePrivate: boolean; cities: Map<string, City> }) {
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
            {s.url && !s.place ? (
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="block truncate text-sky hover:underline">
                {s.url}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
      {s.kind === "activity" ? <FoundLinks s={s} cities={cities} /> : null}
      {s.kind === "stay" ? <MapsLink name={s.hotelName} near={s.place?.address ?? s.areaName ?? undefined} className="text-xs" /> : null}
      {s.kind === "stay" && s.place?.website ? (
        <a href={s.place.website} target="_blank" rel="noopener noreferrer" className="text-xs text-sky hover:underline">
          Hotel website
        </a>
      ) : null}
    </>
  );
}

function ItemCard({ item, tripId, stops, canSeePrivate, routeId }: { item: InboxItem; tripId: string; stops: StopView[]; canSeePrivate: boolean; routeId?: string }) {
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
  const cityMap = new Map(stops.map((s) => [s.city.code, s.city]));
  const cities = [...cityMap.values()];
  const status = STATUS[item.status];

  return (
    <li className="ticket flex flex-col gap-2 p-3 sm:p-4" data-testid="inbox-item" data-status={item.status} data-kind={item.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-board px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber">{KIND_LABEL[item.kind]}</span>
        <span className="min-w-0 flex-1 font-semibold">{item.summary}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${status.style}`}>{status.label}</span>
      </div>
      {item.suggestion ? <Details s={item.suggestion} canSeePrivate={canSeePrivate} cities={cityMap} /> : null}
      <LookupState item={item} tripId={tripId} />
      {item.note ? <p className={`text-xs ${item.status === "failed" ? "text-err" : "text-ink-soft"}`}>{item.note}</p> : null}
      {item.status === "applied" && item.kind === "stay" && item.stopId && routeId && item.note?.includes("The booking is") ? (
        <Link href={routeHref(tripId, routeId, `stop-${item.stopId}`)} className="text-xs font-medium text-sky hover:underline" data-testid="fit-plan-link">
          Fit the plan to this booking
        </Link>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
        <span>{item.source === "email" ? `Emailed by ${item.fromName ?? item.from ?? "someone"}` : `Pasted by ${item.fromName ?? "someone"}`}</span>
        {item.subject ? <span className="truncate">“{item.subject}”</span> : null}
        <span>{when(item.receivedAt)}</span>
        {item.stopLabel && item.status === "applied" ? <span>→ {item.stopLabel}</span> : null}
        {item.appliedBy && item.status === "applied" ? <span>added by {item.appliedBy}</span> : null}
      </div>
      {open && item.kind !== "unknown" ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-line pt-3">
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
          <Button size="sm" variant="ghost" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}>
            Discard
          </Button>
        </div>
      ) : open ? (
        <div className="mt-1 border-t border-line pt-3">
          <Button size="sm" variant="ghost" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}>
            Discard
          </Button>
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
      className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) paste.mutate();
      }}
    >
      <label htmlFor="inbox-paste" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
        Paste a confirmation or a link
      </label>
      <textarea
        id="inbox-paste"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="Paste a booking confirmation email, a TikTok, Instagram or YouTube link, or a note like “Shibuya Sky in Tokyo looks amazing”."
        className="w-full flex-1 rounded-xl border border-line bg-paper px-3 py-2 text-sm outline-none focus:border-ink-faint"
      />
      <div className="flex flex-wrap items-center gap-3">
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
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">Forward to the trip</div>
      {data.address ? (
        <>
          <div className="flex items-center gap-2 rounded-xl border border-line bg-paper p-2 pl-3">
            <code className="min-w-0 flex-1 truncate font-mono text-sm font-medium select-all" data-testid="inbox-address">
              {data.address}
            </code>
            <Button size="sm" variant="primary" onClick={() => void navigator.clipboard?.writeText(data.address!).then(() => toast("Address copied", "ok"))}>
              Copy
            </Button>
          </div>
          <p className="text-sm text-ink-soft">
            Forward booking confirmations, or send links to TikToks, Reels and YouTube videos. Mail from the email address on your Trippr account is added
            straight away; anything else waits below for an editor.
          </p>
          {isOwner ? (
            <button
              className="self-start text-xs text-ink-soft hover:underline"
              onClick={() => window.confirm("Make a new address? The current one will stop working.") && rotate.mutate()}
            >
              Make a new address
            </button>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-ink-soft">Email isn&apos;t set up on this deployment yet. Paste confirmations and links instead.</p>
      )}
      <p className="mt-auto border-t border-line pt-2 text-xs text-ink-faint">
        {data.reader === "claude"
          ? data.lookup
            ? "Claude reads each message for tickets, hotels and places to go, then looks up each place's website, tickets and pin."
            : "Claude reads each message for tickets, hotels and places to go."
          : "Links are turned into activity ideas. Reading tickets and hotels from confirmations needs Claude to be set up."}
      </p>
    </div>
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
      <>
        <BoardHeader eyebrow={`${trip.data.trip.name} · inbox`} title="Inbox" width="max-w-5xl" />
        <main className="mx-auto max-w-5xl px-4 py-5 sm:px-6">
          <div className="rounded-2xl border border-dashed border-line bg-card px-5 py-8 text-center">
            <p className="font-semibold">The inbox is for editors</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">
              It holds the booking emails and links people forward to the trip. Ask the trip owner to make you an editor to see it.
            </p>
          </div>
        </main>
      </>
    );
  }

  const list = (stops: StopView[], group: InboxItem[]) => (
    <ol className="space-y-3">
      {group.map((i) => (
        <ItemCard key={i.id} item={i} tripId={tripId} stops={stops} canSeePrivate={q.data?.canSeePrivate ?? false} routeId={currentRouteId} />
      ))}
    </ol>
  );

  const body = (stops: StopView[]) => (
    <main className="mx-auto max-w-5xl space-y-7 px-4 py-5 sm:px-6">
      {/* Two ways in, side by side. */}
      <section className="grid gap-4 lg:grid-cols-2" aria-label="Send things to the trip">
        {q.data ? <AddressPanel tripId={tripId} data={q.data} isOwner={trip.data?.role === "owner"} /> : null}
        <PasteBox tripId={tripId} />
      </section>
      {q.isPending ? <Spinner /> : null}
      {q.error ? <ErrorNote error={q.error} /> : null}
      {q.data ? (
        <>
          <section aria-labelledby="inbox-waiting">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="inbox-waiting" className="text-sm font-semibold">
                Needs a look · {waiting.length}
              </h2>
              {waiting.length ? <span className="text-xs text-ink-soft">Check the stop or city, then add it or discard it.</span> : null}
            </div>
            {waiting.length ? (
              list(stops, waiting)
            ) : (
              <p className="rounded-2xl border border-dashed border-line bg-card px-4 py-6 text-center text-sm text-ink-soft">
                Nothing waiting. New messages show up here.
              </p>
            )}
          </section>
          {done.length ? (
            <section aria-labelledby="inbox-done">
              <h2 id="inbox-done" className="mb-3 text-sm font-semibold">
                Done · {done.length}
              </h2>
              {list(stops, done)}
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  );

  return (
    <>
      <BoardHeader
        eyebrow={`${trip.data?.trip.name ?? "Trip"} · inbox`}
        title="Inbox"
        width="max-w-5xl"
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
  return (
    <RequireAuth>
      <Inbox tripId={tripId} />
    </RequireAuth>
  );
}
