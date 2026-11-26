"use client";

import { AREA_VIBES, type Area, type AreaVibe, type Hotel, type PriceBasis, type RouteView, type StayStatus, type StopView } from "@trippr/contracts";
import { dayDate, hotelLinks } from "@trippr/rules";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAreas, useCreateArea, useCreateHotel, useDeleteHotel, useHotels, useRouteWrite, useVoteOn } from "@/lib/explorer";
import { keys } from "@/lib/queries";
import { BookingLinks } from "./booking-links";
import { ThumbDownIcon, ThumbUpIcon, XIcon } from "./icons";
import { MapsLink } from "./maps-link";
import { StayCard } from "./stay-card";
import { Button, ErrorNote, Input, Label, Select, Spinner, Tag } from "./ui";

const STATUS_LABEL: Record<StayStatus, string> = { shortlist: "Shortlisted", chosen: "Chosen", booked: "Booked" };
const STATUS_STYLE: Record<StayStatus, string> = {
  shortlist: "border border-dashed border-ink-faint text-ink-soft",
  chosen: "bg-sky/15 text-sky",
  booked: "bg-ok/15 text-ok",
};

/**
 * The dates a hotel was booked for. They become fixed dates the route builder
 * works around, so they're asked for rather than copied from the plan.
 */
function BookingDates({
  hotelName,
  arrive,
  depart,
  pending,
  onSave,
  onCancel,
}: {
  hotelName: string;
  arrive: string;
  depart: string;
  pending: boolean;
  onSave: (arrive: string, depart: string) => void;
  onCancel: () => void;
}) {
  const [from, setFrom] = useState(arrive);
  const [to, setTo] = useState(depart);
  const valid = Boolean(from && to && from < to);
  return (
    <form
      className="mt-2 grid gap-2 rounded-lg bg-paper p-2.5 text-xs"
      data-testid="booking-dates"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave(from, to);
      }}
    >
      <p className="text-ink-soft">Which dates is {hotelName} booked for? The route keeps them fixed when you change the plan.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-0.5">
          <span className="text-ink-faint">Check in</span>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={`Check-in at ${hotelName}`} className="h-8 text-xs" />
        </label>
        <label className="grid gap-0.5">
          <span className="text-ink-faint">Check out</span>
          <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label={`Check-out at ${hotelName}`} className="h-8 text-xs" />
        </label>
        <Button size="sm" type="submit" disabled={!valid || pending}>
          Save booking
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {from && to && !valid ? <p className="text-err">Check-out has to be after check-in.</p> : null}
    </form>
  );
}

export const perPerson = (h: Pick<Hotel, "priceCadPerNight" | "priceBasis" | "sleeps">) =>
  h.priceCadPerNight == null ? null : h.priceBasis === "room" ? Math.round(h.priceCadPerNight / Math.max(h.sleeps, 1)) : h.priceCadPerNight;

function Votes({ id, votes, myVote, kind, canVote, label }: { id: string; votes: number; myVote: -1 | 0 | 1; kind: "hotels" | "areas"; canVote: boolean; label: string }) {
  const vote = useVoteOn(kind);
  const cast = (v: -1 | 1) => vote.mutate({ id, value: myVote === v ? 0 : v });
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <button aria-label={`Vote up ${label}`} aria-pressed={myVote === 1} disabled={!canVote} onClick={() => cast(1)} className={`rounded p-1 ${myVote === 1 ? "bg-ok/15 text-ok" : "text-ink-faint hover:text-ink"} disabled:opacity-40`}>
        <ThumbUpIcon className="h-3.5 w-3.5" />
      </button>
      <span className="w-5 text-center font-mono text-xs font-semibold">{votes}</span>
      <button aria-label={`Vote down ${label}`} aria-pressed={myVote === -1} disabled={!canVote} onClick={() => cast(-1)} className={`rounded p-1 ${myVote === -1 ? "bg-err/15 text-err" : "text-ink-faint hover:text-ink"} disabled:opacity-40`}>
        <ThumbDownIcon className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

function AddAreaForm({ tripId, cityCode, cityName }: { tripId: string; cityCode: string; cityName: string }) {
  const create = useCreateArea();
  const [name, setName] = useState("");
  const [vibes, setVibes] = useState<AreaVibe[]>([]);
  return (
    <form
      className="space-y-2 rounded-xl border border-dashed border-ink-faint/60 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate({ tripId, cityCode, name: name.trim(), vibes }, { onSuccess: () => { setName(""); setVibes([]); } });
      }}
    >
      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">Suggest an area in {cityName}</div>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Neighbourhood, e.g. Sheung Wan" aria-label="Area name" required />
      <div className="flex flex-wrap gap-1">
        {AREA_VIBES.map((v) => (
          <button
            type="button"
            key={v}
            aria-pressed={vibes.includes(v)}
            onClick={() => setVibes((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]))}
            className={`rounded-md border px-2 py-0.5 text-xs ${vibes.includes(v) ? "border-board bg-board text-amber" : "border-line"}`}
          >
            {v}
          </button>
        ))}
      </div>
      <Button type="submit" size="sm" variant="primary" disabled={create.isPending || !name.trim()}>
        Add area
      </Button>
      {create.error ? <ErrorNote error={create.error} /> : null}
    </form>
  );
}

function AddHotelForm({ tripId, areas, cityName }: { tripId: string; areas: Area[]; cityName: string }) {
  const create = useCreateHotel();
  const [areaId, setAreaId] = useState(areas[0]?.id ?? "");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [price, setPrice] = useState("");
  const [basis, setBasis] = useState<PriceBasis>("room");
  const [sleeps, setSleeps] = useState(2);
  useEffect(() => {
    if (!areaId && areas[0]) setAreaId(areas[0].id);
  }, [areas, areaId]);
  if (!areas.length) return <p className="text-xs text-ink-faint">Add an area first, then hotels in it.</p>;
  return (
    <form
      className="space-y-2 rounded-xl border border-dashed border-ink-faint/60 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(
          { tripId, areaId, name: name.trim(), url: url.trim() || null, priceCadPerNight: price ? Number(price) : null, priceBasis: basis, sleeps },
          { onSuccess: () => { setName(""); setUrl(""); setPrice(""); } },
        );
      }}
    >
      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">Add a hotel in {cityName}</div>
      <Select value={areaId} onChange={(e) => setAreaId(e.target.value)} aria-label="Area" className="w-full">
        {areas.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Hotel name" aria-label="Hotel name" required />
      <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link (optional)" aria-label="Hotel link" />
      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label htmlFor="hotel-price">CAD / night</Label>
          <Input id="hotel-price" type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="hotel-basis">Price is per</Label>
          <Select id="hotel-basis" value={basis} onChange={(e) => setBasis(e.target.value as PriceBasis)} className="w-full">
            <option value="room">room</option>
            <option value="person">person</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="hotel-sleeps">Sleeps</Label>
          <Input id="hotel-sleeps" type="number" min={1} max={12} value={sleeps} onChange={(e) => setSleeps(Math.max(1, Number(e.target.value) || 1))} />
        </div>
      </div>
      <Button type="submit" size="sm" variant="primary" disabled={create.isPending || !name.trim() || !areaId}>
        Add hotel
      </Button>
      {create.error ? <ErrorNote error={create.error} /> : null}
    </form>
  );
}

/** "Where to stay": areas worth staying in, and the hotels the group shortlisted, for one stop. */
export function HotelDrawer({
  routeId,
  tripId,
  stop,
  canEdit,
  canVote,
  onClose,
}: {
  routeId: string;
  tripId: string;
  stop: StopView;
  canEdit: boolean;
  canVote: boolean;
  onClose: () => void;
}) {
  const areas = useAreas(tripId, stop.city.code);
  const hotels = useHotels(tripId, stop.city.code);
  const write = useRouteWrite(routeId);
  const remove = useDeleteHotel();
  const panel = useRef<HTMLDivElement>(null);
  const stayFor = (h: Hotel) => h.stays.find((s) => s.stopId === stop.id);
  const travellers = useQueryClient().getQueryData<RouteView>(keys.route(routeId))?.trip.travellers ?? 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setStay = (h: Hotel, status: StayStatus) => write.mutate({ kind: "setStay", stopId: stop.id, hotelId: h.id, status });
  const [booking, setBooking] = useState<string | null>(null);
  const bookedDates = (hotelId: string) => stop.stays.find((s) => s.hotel.id === hotelId && s.status === "booked");

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Where to stay in ${stop.city.name}`}>
      <button className="absolute inset-0 bg-board/40" aria-label="Close where to stay" onClick={onClose} />
      <div ref={panel} tabIndex={-1} className="relative flex h-full w-full max-w-md flex-col bg-paper shadow-2xl focus:outline-none">
        <div className="bg-board px-4 py-4 text-amber-soft">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-amber-soft/60">Where to stay</div>
              <div className="mt-1 text-xl font-semibold text-amber">
                {stop.city.name} <span className="font-mono text-sm text-amber-soft/70">{stop.city.code}</span>
              </div>
              <div className="font-mono text-xs text-amber-soft/70">
                {dayDate(stop.arrive)} → {dayDate(stop.depart)} · {stop.nights} night{stop.nights === 1 ? "" : "s"}
              </div>
            </div>
            <button onClick={onClose} className="rounded p-1.5 hover:bg-board-3" aria-label="Close">
              <XIcon />
            </button>
          </div>
          <p className="mt-2 text-xs text-amber-soft/70">
            Areas and hotels belong to the city, so every route through {stop.city.name} shares this list. Choosing one sets this stop&apos;s stay cost.
          </p>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <BookingLinks
            label={`Search ${stop.city.name} hotels for these dates on`}
            links={hotelLinks({ code: stop.city.code, name: stop.city.name, countryIso: stop.city.countryIso }, stop.arrive, stop.depart, travellers)}
          />
          {areas.isPending || hotels.isPending ? <Spinner /> : null}
          {areas.error ? <ErrorNote error={areas.error} /> : null}
          {hotels.error ? <ErrorNote error={hotels.error} /> : null}

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">Areas</h3>
            {areas.data?.length === 0 ? <p className="text-sm text-ink-soft">No areas suggested yet.</p> : null}
            <ul className="space-y-2">
              {areas.data?.map((a) => (
                <li key={a.id} className="flex items-start gap-3 rounded-xl border border-line bg-card p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-medium">
                      {a.name}
                      <MapsLink name={a.name} near={a.cityName} lat={a.lat} lon={a.lon} className="text-xs font-normal" />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {a.vibes.map((v) => (
                        <Tag key={v}>{v}</Tag>
                      ))}
                      <span className="text-xs text-ink-faint">{a.hotelCount} hotel{a.hotelCount === 1 ? "" : "s"}</span>
                    </div>
                    {a.note ? <p className="mt-1 text-xs text-ink-soft">{a.note}</p> : null}
                    <StayCard
                      areaId={a.id}
                      areaName={a.name}
                      city={stop.city}
                      checkIn={stop.arrive}
                      checkOut={stop.depart}
                      travellers={travellers}
                      tripId={tripId}
                      canEdit={canEdit}
                    />
                  </div>
                  <Votes id={a.id} votes={a.votes} myVote={a.myVote} kind="areas" canVote={canVote} label={a.name} />
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">Hotels</h3>
            {hotels.data?.length === 0 ? <p className="text-sm text-ink-soft">No hotels yet.{canEdit ? " Add one below." : ""}</p> : null}
            <ul className="space-y-2">
              {hotels.data?.map((h) => {
                const stay = stayFor(h);
                const pp = perPerson(h);
                return (
                  <li key={h.id} className="rounded-xl border border-line bg-card p-3" data-testid="hotel-item">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium leading-snug">
                          {h.url ? (
                            <a href={h.url} target="_blank" rel="noreferrer" className="hover:underline">
                              {h.name}
                            </a>
                          ) : (
                            h.name
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
                          <span>{h.areaName}</span>
                          <MapsLink name={h.name} near={`${h.areaName}, ${h.cityName}`} lat={h.lat} lon={h.lon} />
                          {h.priceCadPerNight != null ? (
                            <span className="font-mono">
                              ${h.priceCadPerNight}/{h.priceBasis === "room" ? "room" : "person"}
                              {pp != null && h.priceBasis === "room" ? ` · $${pp} pp` : ""}
                            </span>
                          ) : null}
                          {stay ? (
                            <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[stay.status]}`}>{STATUS_LABEL[stay.status]}</span>
                          ) : null}
                        </div>
                      </div>
                      <Votes id={h.id} votes={h.votes} myVote={h.myVote} kind="hotels" canVote={canVote} label={h.name} />
                    </div>
                    {canEdit ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                        {(["shortlist", "chosen", "booked"] as const).map((s) => (
                          <button
                            key={s}
                            disabled={write.isPending || stay?.status === s}
                            onClick={() => (s === "booked" ? setBooking(h.id) : setStay(h, s))}
                            className="rounded-md border border-line px-2 py-0.5 hover:border-ink-faint disabled:border-transparent disabled:bg-paper-2 disabled:text-ink"
                          >
                            {s === "shortlist" ? "Shortlist" : s === "chosen" ? "Choose" : "Mark booked"}
                          </button>
                        ))}
                        {stay ? (
                          <button onClick={() => write.mutate({ kind: "removeStay", stopId: stop.id, hotelId: h.id })} className="text-ink-soft hover:underline">
                            Remove from this stop
                          </button>
                        ) : null}
                        <button
                          onClick={() => {
                            if (window.confirm(`Delete ${h.name} from the hotel list for every route?`)) remove.mutate(h.id);
                          }}
                          className="ml-auto text-err hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                    {bookedDates(h.id)?.arrive && booking !== h.id ? (
                      <p className="mt-1.5 text-xs text-ink-soft" data-testid="booked-dates">
                        Booked <span className="font-mono text-ink">{dayDate(bookedDates(h.id)!.arrive!)} → {dayDate(bookedDates(h.id)!.depart!)}</span>
                        {canEdit ? (
                          <button onClick={() => setBooking(h.id)} className="ml-2 font-medium text-sky hover:underline">
                            Change dates
                          </button>
                        ) : null}
                      </p>
                    ) : null}
                    {booking === h.id ? (
                      <BookingDates
                        hotelName={h.name}
                        arrive={bookedDates(h.id)?.arrive ?? stop.arrive}
                        depart={bookedDates(h.id)?.depart ?? stop.depart}
                        pending={write.isPending}
                        onCancel={() => setBooking(null)}
                        onSave={(arrive, depart) =>
                          write.mutate({ kind: "setStay", stopId: stop.id, hotelId: h.id, status: "booked", arrive, depart }, { onSuccess: () => setBooking(null) })
                        }
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>

          {canEdit ? (
            <div className="space-y-3">
              <AddHotelForm tripId={tripId} areas={areas.data ?? []} cityName={stop.city.name} />
              <AddAreaForm tripId={tripId} cityCode={stop.city.code} cityName={stop.city.name} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** One line on the stop card: the chosen or booked hotel, or how many are shortlisted. */
export function StaySummary({ stop, onOpen }: { stop: StopView; onOpen: () => void }) {
  const stays = stop.stays ?? [];
  const picked = stays.find((s) => s.status === "booked") ?? stays.find((s) => s.status === "chosen");
  const shortlisted = stays.filter((s) => s.status === "shortlist").length;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="stay-summary">
      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Stay</span>
      {picked ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-2 py-0.5">
          <span className="font-medium">{picked.hotel.name}</span>
          <span className="text-ink-faint">· {picked.hotel.areaName}</span>
          {picked.perPersonCadPerNight != null ? <span className="font-mono">· ${picked.perPersonCadPerNight} pp/night</span> : null}
          <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold uppercase ${STATUS_STYLE[picked.status]}`}>{STATUS_LABEL[picked.status]}</span>
        </span>
      ) : (
        <span className="text-ink-faint">{shortlisted ? `${shortlisted} shortlisted` : "Not picked yet"}</span>
      )}
      <button onClick={onOpen} className="font-medium text-sky hover:underline">
        Where to stay
      </button>
    </div>
  );
}
