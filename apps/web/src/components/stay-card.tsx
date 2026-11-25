"use client";

import type { AreaStay, HotelSuggestion, StayPart } from "@trippr/contracts";
import { stayLinks } from "@trippr/rules";
import { useState } from "react";
import { useCreateHotel } from "@/lib/explorer";
import { useAreaStay, useHotelSuggestions } from "@/lib/stay";
import { BookingLinks } from "./booking-links";
import { Button, ErrorNote, Spinner } from "./ui";

const cad = (n: number | null | undefined) => (n == null ? "n/a" : `CAD ${Math.round(n).toLocaleString("en-CA")}`);
/** Open-data websites are free text; only a real http(s) address goes into the hotel list. */
function httpUrl(value: string | null): string | null {
  if (!value || value.length > 500) return null;
  try {
    const u = new URL(value.includes("://") ? value : `https://${value}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
const pct = (n: number | null | undefined) => (n == null ? "n/a" : `${Math.round(n * 100)}%`);

/** One part of the score as a labelled bar: the number is always there, the bar is only a picture of it. */
function Part({ part }: { part: StayPart }) {
  const known = part.score != null;
  return (
    <li className="grid grid-cols-[5.5rem_minmax(0,1fr)_2.25rem] items-center gap-2 text-xs" data-testid="stay-part" data-part={part.key}>
      <span className={known ? "text-ink" : "text-ink-faint"}>
        {part.label} <span className="text-ink-faint">{Math.round(part.weight * 100)}%</span>
      </span>
      <span
        className="h-1.5 overflow-hidden rounded-full bg-paper-2"
        role="img"
        aria-label={known ? `${part.label}: ${Math.round(part.score!)} out of 100` : `${part.label}: not enough data`}
      >
        {known ? <span className="block h-full rounded-full bg-board" style={{ width: `${Math.max(2, Math.min(100, part.score!))}%` }} /> : null}
      </span>
      <span className={`text-right font-mono ${known ? "" : "text-ink-faint"}`}>{known ? Math.round(part.score!) : "n/a"}</span>
    </li>
  );
}

function NoData({ stay }: { stay: AreaStay }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-faint/60 bg-paper px-3 py-2 text-xs text-ink-soft" data-testid="stay-card" data-state="none">
      <div className="font-medium text-ink" data-testid="stay-empty-title">
        {stay.cityCovered ? "No stay numbers for this area" : "No stay data for this city"}
      </div>
      <p className="mt-0.5">{stay.note}</p>
      {stay.location.centreKm != null ? <p className="mt-0.5">{stay.location.centreKm.toFixed(1)} km from the city centre.</p> : null}
    </div>
  );
}

function Suggestions({ areaId, tripId, canEdit }: { areaId: string; tripId: string; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const suggestions = useHotelSuggestions(areaId, open);
  const add = useCreateHotel();
  const [added, setAdded] = useState<Set<string>>(new Set());
  const addHotel = (h: HotelSuggestion) =>
    add.mutate(
      { tripId, areaId, name: h.name.slice(0, 120), url: httpUrl(h.website), lat: h.lat, lon: h.lon, priceBasis: "room", sleeps: 2 },
      { onSuccess: () => setAdded((s) => new Set(s).add(h.id)) },
    );
  return (
    <div className="mt-2" data-testid="stay-suggestions">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="text-xs font-medium text-sky hover:underline" data-testid="stay-suggestions-toggle">
        {open ? "Hide hotels from open data" : "Hotels from open data"}
      </button>
      {open ? (
        <div className="mt-1.5 space-y-1.5">
          {suggestions.isPending ? <Spinner label="Loading hotels" /> : null}
          {suggestions.error ? <ErrorNote error={suggestions.error} /> : null}
          {suggestions.data && suggestions.data.hotels.length === 0 ? <p className="text-xs text-ink-soft">No open-data hotels recorded inside this area.</p> : null}
          <ul className="space-y-1">
            {suggestions.data?.hotels.map((h) => (
              <li key={h.id} className="rounded-md border border-line bg-card px-2 py-1.5 text-xs" data-testid="stay-suggestion">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-snug">
                      {h.website ? (
                        <a href={h.website} target="_blank" rel="noopener noreferrer" className="hover:underline">
                          {h.name}
                        </a>
                      ) : (
                        h.name
                      )}
                    </div>
                    <div className="text-ink-soft">
                      {h.kind.replace("_", " ")}
                      {h.stars ? ` · ${h.stars} star${h.stars === 1 ? "" : "s"}` : ""}
                      {h.distanceKm != null ? ` · ${h.distanceKm.toFixed(1)} km from the centre` : ""}
                      {h.nSources > 1 ? ` · in ${h.nSources} sources` : ""}
                    </div>
                  </div>
                  {canEdit ? (
                    <Button size="sm" disabled={add.isPending || added.has(h.id)} onClick={() => addHotel(h)} aria-label={`Add ${h.name} to the hotel list`}>
                      {added.has(h.id) ? "Added" : "Add"}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {suggestions.data && suggestions.data.total > suggestions.data.hotels.length ? (
            <p className="text-[11px] text-ink-faint">Showing {suggestions.data.hotels.length} of {suggestions.data.total}.</p>
          ) : null}
          {suggestions.data?.attributions.length ? (
            <p className="text-[11px] text-ink-faint" data-testid="stay-suggestion-attribution">
              {suggestions.data.attributions.join(" · ")}
            </p>
          ) : null}
          <p className="text-[11px] text-ink-faint">No prices here: open data has none. Adding one copies its name, link and pin into the group&apos;s hotel list.</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * An Area's stay card in the Where to stay drawer: the score with its parts and the sentence that explains it, the price
 * range from Inside Airbnb, the snapshot it comes from, and honest states when there is no data. The Airbnb and hotel
 * links are plain searches built from the area and the stop's dates.
 */
export function StayCard({
  areaId,
  areaName,
  city,
  checkIn,
  checkOut,
  travellers,
  tripId,
  canEdit,
}: {
  areaId: string;
  areaName: string;
  city: { code: string; name: string; countryIso?: string | null };
  checkIn: string | null;
  checkOut: string | null;
  travellers: number;
  tripId: string;
  canEdit: boolean;
}) {
  const query = useAreaStay(areaId);
  const stay = query.data;
  const links = stayLinks({ area: areaName, city }, checkIn, checkOut, travellers);
  return (
    <div className="mt-2 space-y-2" data-testid="stay-block" data-area={areaId}>
      {query.isPending ? <Spinner label="Loading stay data" /> : null}
      {query.error ? <ErrorNote error={query.error} /> : null}
      {stay && stay.availability === "none" ? <NoData stay={stay} /> : null}
      {stay && stay.availability !== "none" ? (
        <div className="rounded-lg border border-line bg-paper px-3 py-2" data-testid="stay-card" data-state={stay.availability}>
          <div className="flex items-baseline justify-between gap-2">
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-soft">Stay score</span>
              <span className="ml-2 font-mono text-lg font-semibold" data-testid="stay-score">
                {stay.score != null ? Math.round(stay.score) : "n/a"}
              </span>
              <span className="font-mono text-xs text-ink-faint"> /100</span>
            </div>
            {stay.weightCoverage != null && stay.weightCoverage < 1 ? (
              <span className="text-[11px] text-ink-faint" data-testid="stay-partial">
                {Math.round(stay.weightCoverage * 100)}% of the score has data
              </span>
            ) : null}
          </div>
          <ul className="mt-1.5 space-y-1" aria-label="Score parts" data-testid="stay-parts">
            {stay.parts.map((p) => (
              <Part key={p.key} part={p} />
            ))}
          </ul>
          {stay.price ? (
            <p className="mt-2 text-sm" data-testid="stay-price">
              <span className="font-mono font-semibold">
                {cad(stay.price.p25Cad)} to {cad(stay.price.p75Cad)}
              </span>{" "}
              a night
              <span className="block text-xs text-ink-soft">
                Median {cad(stay.price.medianCad)}
                {stay.price.perPersonCad != null ? ` · ${cad(stay.price.perPersonCad)} a person` : ""}
                {stay.price.cityMedianCad != null ? ` · ${stay.cityName} median ${cad(stay.price.cityMedianCad)}` : ""}
              </span>
            </p>
          ) : null}
          {stay.market ? (
            <p className="mt-1 text-xs text-ink-soft" data-testid="stay-market">
              {stay.market.listings} listings
              {stay.market.medianRating != null ? ` · rated ${stay.market.medianRating.toFixed(2)}` : ""}
              {stay.market.entireHomeShare != null ? ` · ${pct(stay.market.entireHomeShare)} entire homes` : ""}
              {stay.market.unavailableShare != null ? ` · ${pct(stay.market.unavailableShare)} of next year's nights taken` : ""}
            </p>
          ) : null}
          {stay.explanation ? (
            <p className="mt-1.5 text-xs text-ink-soft" data-testid="stay-explanation">
              {stay.explanation}
            </p>
          ) : null}
          <p className="mt-1.5 text-[11px] text-ink-faint" data-testid="stay-note">
            {stay.note}
          </p>
          {stay.snapshotDate ? (
            <p className="text-[11px] text-ink-faint" data-testid="stay-snapshot">
              Snapshot {stay.snapshotDate}
            </p>
          ) : null}
          {stay.coverage ? (
            <p className="text-[11px] text-ink-faint" data-testid="stay-coverage">
              {stay.coverage.note}.
            </p>
          ) : null}
          {stay.attribution ? (
            <p className="text-[11px] text-ink-faint" data-testid="stay-attribution">
              {stay.attribution}
            </p>
          ) : null}
        </div>
      ) : null}
      <BookingLinks links={links} label="" className="text-xs" />
      {stay && stay.hotelSuggestions > 0 ? <Suggestions areaId={areaId} tripId={tripId} canEdit={canEdit} /> : null}
    </div>
  );
}
