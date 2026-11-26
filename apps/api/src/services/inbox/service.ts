import {
  hasRole,
  type AcceptBody,
  type ActivitySuggestion,
  type InboxItem,
  type InboxLookupState,
  type InboxSource,
  type FoundPlace,
  type InboxSuggestion,
  type LegSuggestion,
  type LibraryActivity,
  type Role,
  type RouteView,
  type StaySuggestion,
  type StopView,
} from "@trippr/contracts";
import { classifyLink, urlsIn } from "@trippr/rules";
import type { AppContext } from "../../app";
import { AppError, badRequest } from "../../errors";
import { nowIso } from "../../ids";
import type { StoredRoute } from "../../repositories";
import { buildRouteView } from "../route-view";
import { findLinks, htmlToText, previewLinks, type LinkPreview } from "./links";
import { findPlace, LOOKUP_BUDGET_MS, MAX_LOOKUPS_PER_MESSAGE, type FindOutcome, type LookupCity, type LookupInput } from "./lookup";
import { MAX_BODY_CHARS, type ExtractedItem, type ReaderContext } from "./reader";

export interface Sender {
  id: string;
  name: string | null;
  role: Role | null;
}

export interface Incoming {
  tripId: string;
  source: InboxSource;
  from: string | null;
  fromName: string | null;
  subject: string | null;
  text: string;
  html?: string | null;
  pdfs?: { name: string; base64: string }[];
  /** The trip member who sent it, when known. */
  sender: Sender | null;
  /** Whether the sender is who they say they are (signed in, or SPF/DKIM passed). */
  trusted: boolean;
}

class ApplyError extends Error {}

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TAG = /^[a-z0-9][a-z0-9 -]*$/;

const dateTimeOrNull = (v: string | null | undefined) => (v && LOCAL_DATE_TIME.test(v) ? v : null);
const dateOrNull = (v: string | null | undefined) => (v && ISO_DATE.test(v.slice(0, 10)) ? v.slice(0, 10) : null);
const cut = (v: string | null | undefined, max: number) => (v ? v.trim().slice(0, max) || null : null);
const moneyOrNull = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100_000 ? Math.round(v * 100) / 100 : null);
const urlOrNull = (v: string | null | undefined) => {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
};
const norm = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const slug = (s: string) => norm(s).replace(/ /g, "-").slice(0, 40) || "unnamed";
const daysBetween = (a: string, b: string) => Math.abs(Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
const shortDay = (d: string) =>
  new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });

export const stopLabel = (s: StopView) => `${s.city.name} (stop ${s.order + 1})`;

/**
 * Reads inbox messages into suggestions and applies them. Applying goes
 * through the API's own endpoints as the person responsible, so the same
 * validation, role checks, version locking and live updates apply as when
 * someone adds the ticket by hand.
 */
interface Found {
  id: string;
  suggestion: InboxSuggestion;
  waiting: string | null;
  lookup: boolean;
}

export function createInbox(ctx: AppContext) {
  const { repos, config } = ctx;

  async function currentRoute(tripId: string): Promise<StoredRoute | null> {
    const ids = await repos.trips.routeIds(tripId);
    const stored = (await Promise.all(ids.map((id) => repos.routes.load(id)))).filter((r) => r !== null);
    return stored.find((r) => r.route.isCurrent) ?? stored[0] ?? null;
  }

  async function readerContext(tripId: string, view: RouteView | null): Promise<ReaderContext> {
    const cities = await repos.cities.search("", 200);
    const trip = view ? null : await repos.trips.get(tripId);
    return {
      cities: cities.map((c) => ({ code: c.code, name: c.name, countryName: c.countryName })),
      stops: view?.stops.map((s) => ({ code: s.city.code, name: s.city.name, arrive: s.arrive, depart: s.depart })) ?? [],
      travellers: view?.trip.travellers ?? trip?.travellers ?? 1,
      today: nowIso().slice(0, 10),
    };
  }

  function toSuggestion(ex: ExtractedItem, known: Set<string>, links: LinkPreview[]): InboxSuggestion | null {
    const code = (c: string | null | undefined) => {
      const upper = c?.trim().toUpperCase() ?? "";
      return known.has(upper) ? upper : null;
    };
    const iata = (c: string | null | undefined) => (c && /^[A-Za-z]{3}$/.test(c.trim()) ? c.trim().toUpperCase() : null);
    if (ex.kind === "leg" && ex.leg) {
      const l = ex.leg;
      return {
        kind: "leg",
        mode: l.mode,
        status: l.status,
        fromCityCode: code(l.fromCityCode),
        toCityCode: code(l.toCityCode),
        fromName: cut(l.fromName, 120),
        toName: cut(l.toName, 120),
        fromAirport: l.mode === "flight" ? iata(l.fromAirport) : null,
        toAirport: l.mode === "flight" ? iata(l.toAirport) : null,
        operator: cut(l.operator, 80),
        number: cut(l.number, 40),
        departAt: dateTimeOrNull(l.departAt),
        arriveAt: dateTimeOrNull(l.arriveAt),
        pricePerPersonCad: moneyOrNull(l.pricePerPersonCad),
        bookingRef: cut(l.bookingRef, 80),
        seat: cut(l.seat, 40),
      };
    }
    if (ex.kind === "stay" && ex.stay) {
      const s = ex.stay;
      return {
        kind: "stay",
        status: s.status,
        hotelName: cut(s.hotelName, 120) ?? "Hotel",
        cityCode: code(s.cityCode),
        areaName: cut(s.areaName, 80),
        checkIn: dateOrNull(s.checkIn),
        checkOut: dateOrNull(s.checkOut),
        rooms: s.rooms && s.rooms >= 1 && s.rooms <= 10 ? s.rooms : null,
        perNightCad: moneyOrNull(s.perNightCad),
        url: urlOrNull(s.url),
        bookingRef: cut(s.bookingRef, 80),
      };
    }
    if (ex.kind === "activity" && ex.activity) {
      const a = ex.activity;
      const url = urlOrNull(a.url);
      return {
        kind: "activity",
        title: cut(a.title, 120) ?? "Idea",
        cityCode: code(a.cityCode),
        url,
        tags: [...new Set(a.tags.map((t) => t.trim().toLowerCase().slice(0, 24)).filter((t) => TAG.test(t)))].slice(0, 8),
        costCad: moneyOrNull(a.costCad),
        note: cut(a.note, 240),
        thumbnailUrl: links.find((l) => l.url === url)?.thumbnailUrl ?? null,
      };
    }
    return null;
  }

  /** The stop a suggestion belongs to: same city, closest arrival date. */
  function matchStop(view: RouteView | null, s: InboxSuggestion, override?: AcceptBody): StopView | null {
    if (!view) return null;
    if (override?.stopId) return view.stops.find((st) => st.id === override.stopId) ?? null;
    const city = s.kind === "leg" ? s.toCityCode : s.cityCode;
    const date = s.kind === "leg" ? (s.arriveAt ?? s.departAt) : s.kind === "stay" ? s.checkIn : null;
    const candidates = view.stops.filter((st) => st.city.code === city);
    if (candidates.length <= 1 || !date) return candidates[0] ?? null;
    return [...candidates].sort((a, b) => daysBetween(a.arrive, date) - daysBetween(b.arrive, date))[0]!;
  }

  function waitingNote(s: InboxSuggestion, target: StopView | null, cityName: (code: string | null) => string | null): string | null {
    if (s.kind === "activity") return s.cityCode ? null : "Which city is this in? Pick one to add it.";
    if (target) return null;
    const city = cityName(s.kind === "leg" ? s.toCityCode : s.cityCode);
    return `${city ?? "This place"} isn't on the current route. Pick a stop to add it to.`;
  }

  /** Calls the API as `actor` with a short-lived token. */
  async function actingAs(actor: { id: string; name: string | null }) {
    const token = await ctx.auth.issue({ id: actor.id, name: actor.name }, "5m");
    return async <T = unknown>(method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object): Promise<T> => {
      const res = await ctx.inject({ method, url, ...(payload ? { payload } : {}), headers: { authorization: `Bearer ${token}` } });
      let body: { error?: { message?: string } } | undefined;
      try {
        body = res.json() as typeof body;
      } catch {
        body = undefined;
      }
      if (res.statusCode >= 400) throw new AppError(res.statusCode, "bad_request", body?.error?.message ?? `Request failed (${res.statusCode})`);
      return body as T;
    };
  }

  type Call = Awaited<ReturnType<typeof actingAs>>;

  /** A route-structure write with the route's current version, retried once if someone else wrote first. */
  async function withVersion<T>(routeId: string, write: (version: number) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const stored = await repos.routes.load(routeId);
      if (!stored) throw new ApplyError("The route was deleted.");
      try {
        return await write(stored.route.version);
      } catch (e) {
        if (attempt === 0 && e instanceof AppError && e.status === 409) continue;
        throw e;
      }
    }
  }

  async function hubFor(side: "from" | "to", s: LegSuggestion): Promise<{ kind: "station" | "airport"; id: string }> {
    const cityCode = side === "from" ? s.fromCityCode : s.toCityCode;
    const name = side === "from" ? s.fromName : s.toName;
    const airport = side === "from" ? s.fromAirport : s.toAirport;
    const city = cityCode ? await repos.cities.get(cityCode) : null;
    if (s.mode === "flight") {
      if (!airport) throw new ApplyError(`Couldn't tell which airport the flight ${side === "from" ? "leaves from" : "lands at"}.`);
      const known = await repos.explorer.getHubs([airport]);
      if (known.get(airport)?.kind === "airport") return { kind: "airport", id: airport };
      const hub = await repos.inbox.ensureHub({
        hubId: airport,
        kind: "airport",
        code: airport,
        name: name ?? `${city?.name ?? airport} airport (${airport})`,
        cityCode: city?.code ?? null,
        cityName: city?.name ?? null,
        lat: city?.lat ?? null,
        lon: city?.lon ?? null,
      });
      return { kind: hub.kind, id: hub.hubId };
    }
    if (!city) throw new ApplyError(`Couldn't tell where the ${side === "from" ? "journey starts" : "journey ends"}.`);
    const stations = await repos.explorer.searchHubs({ q: "", city: city.code, kind: "station", limit: 50 });
    const wanted = norm(name);
    const named = wanted ? stations.find((h) => norm(h.name).includes(wanted) || wanted.includes(norm(h.name))) : undefined;
    if (named) return { kind: "station", id: named.id };
    if (!wanted && stations[0]) return { kind: "station", id: stations[0].id };
    const label = name ?? `${city.name} station`;
    const hub = await repos.inbox.ensureHub({
      hubId: `stn-${slug(label)}`,
      kind: "station",
      code: null,
      name: label,
      cityCode: city.code,
      cityName: city.name,
      lat: city.lat,
      lon: city.lon,
    });
    return { kind: hub.kind, id: hub.hubId };
  }

  async function addLeg(call: Call, routeId: string, stop: StopView, s: LegSuggestion): Promise<string> {
    const day = (s.departAt ?? "").slice(0, 10);
    const dup = stop.legs.find((l) => s.number && l.number === s.number && (!day || (l.departAt ?? "").startsWith(day)));
    if (dup) return `${s.number} is already on ${stopLabel(stop)}.`;
    const from = await hubFor("from", s);
    const to = await hubFor("to", s);
    await withVersion(routeId, (version) =>
      call("POST", `/stops/${stop.id}/legs`, {
        mode: s.mode,
        from,
        to,
        operator: s.operator,
        number: s.number,
        departAt: s.departAt,
        arriveAt: s.arriveAt,
        priceCad: s.pricePerPersonCad,
        status: s.status,
        bookingRef: s.bookingRef,
        seat: s.seat,
        version,
      }),
    );
    return `Added to ${stopLabel(stop)} as ${s.status}.`;
  }

  async function addStay(call: Call, tripId: string, actorId: string, routeId: string, stop: StopView, s: StaySuggestion): Promise<string> {
    const city = stop.city.code;
    const hotels = await repos.explorer.listHotels(tripId, actorId, { city });
    let hotel = hotels.find((h) => norm(h.name) === norm(s.hotelName));
    if (!hotel) {
      const areas = await repos.explorer.listAreas(tripId, actorId, { city });
      const areaName = s.areaName ?? "Booked hotels";
      let area = areas.find((a) => norm(a.name) === norm(areaName));
      if (!area) area = await call("POST", "/areas", { tripId, cityCode: city, name: areaName });
      // A pin from the place lookup only when it was confident; otherwise the hotel waits for one.
      const pinned = s.place?.placeStatus === "placed" && s.place.lat != null && s.place.lon != null;
      hotel = await call("POST", "/hotels", {
        tripId,
        areaId: area!.id,
        name: s.hotelName,
        url: s.url ?? s.place?.website ?? null,
        ...(pinned ? { lat: s.place!.lat, lon: s.place!.lon } : {}),
        priceCadPerNight: s.perNightCad,
        priceBasis: "room",
        sleeps: 2,
      });
    }
    const existing = stop.stays.find((st) => st.hotel.id === hotel!.id);
    if (existing?.status === "booked") return `${s.hotelName} is already booked for ${stopLabel(stop)}.`;
    await withVersion(routeId, (version) =>
      call("PUT", `/stops/${stop.id}/stays/${hotel!.id}`, {
        status: s.status,
        ...(s.rooms ? { rooms: s.rooms } : {}),
        // A booking keeps the dates on the confirmation, so the route builder can work around them.
        ...(s.status === "booked" && s.checkIn && s.checkOut && s.checkIn < s.checkOut ? { arrive: s.checkIn, depart: s.checkOut } : {}),
        version,
      }),
    );
    const dates =
      s.checkIn && s.checkOut && (s.checkIn !== stop.arrive || s.checkOut !== stop.depart)
        ? ` The booking is ${shortDay(s.checkIn)} to ${shortDay(s.checkOut)}; the stop is ${shortDay(stop.arrive)} to ${shortDay(stop.depart)}.`
        : "";
    return `Added to ${stopLabel(stop)} as ${s.status}.${dates}`;
  }

  /**
   * Gives an existing activity what the lookup found, without overwriting
   * anything people entered: empty links (and the source link) are filled, the
   * date is set when there is none, and the pin is set unless someone placed
   * it by hand, or it already has one and the new find isn't confident.
   * Returns a short note about the pin.
   */
  async function enrichActivity(
    call: Call,
    tripId: string,
    actorId: string,
    activityId: string,
    place: FoundPlace | null | undefined,
    sourceUrl: string | null,
  ): Promise<string> {
    if (!place && !sourceUrl) return "";
    const activity = await repos.activities.get(tripId, actorId, activityId);
    if (!activity) return "";
    const patch: Record<string, unknown> = {};
    if (!activity.url && sourceUrl) patch.url = sourceUrl;
    if (!activity.website && place?.website) patch.website = place.website;
    if (!activity.ticketUrl && place?.ticketUrl) patch.ticketUrl = place.ticketUrl;
    if (!activity.reserveUrl && place?.reserveUrl) patch.reserveUrl = place.reserveUrl;
    if (!activity.when && place?.eventDate) patch.when = { on: place.eventDate };
    let changed = false;
    let pinNote = "";
    try {
      if (Object.keys(patch).length) {
        await call("PATCH", `/activities/${activity.id}`, patch);
        changed = true;
      }
      const hasPin = activity.lat != null && activity.lon != null;
      const better = !hasPin || place?.placeStatus === "placed";
      if (place && (place.placeStatus || place.mapsUrl) && activity.placeStatus !== "manual" && better) {
        await ctx.places.pinFound(activity, {
          point: place.lat != null && place.lon != null ? { lat: place.lat, lon: place.lon } : null,
          address: place.address ?? null,
          status: place.placeStatus ?? null,
          mapsUrl: activity.mapsUrl ? null : (place.mapsUrl ?? null),
        });
        changed = true;
        if (place.placeStatus === "check") pinNote = " Check the pin on the map.";
        if (place.placeStatus === "not_found") pinNote = " Couldn't find it on the map.";
      }
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      ctx.log.warn({ err: e }, "couldn't update the activity after a lookup");
    }
    if (changed) ctx.notify(tripId, { kind: "activities" }, actorId);
    return pinNote;
  }

  async function addActivity(call: Call, tripId: string, actorId: string, s: ActivitySuggestion): Promise<{ note: string; activityId: string }> {
    const code = s.cityCode!;
    const existing = await call<{ id: string; title: string; url?: string | null }[]>("GET", `/cities/${code}/activities?tripId=${encodeURIComponent(tripId)}`);
    const city = await repos.cities.get(code);
    const dup = existing.find((a) => (s.url && a.url === s.url) || norm(a.title) === norm(s.title));
    if (dup) {
      // Already an idea: it still gets the links and pin the lookup found, where it has none.
      const pinNote = s.place ? await enrichActivity(call, tripId, actorId, dup.id, s.place, s.url) : "";
      const filled = s.place ? " Added the links that were missing." : "";
      return { note: `${dup.title} is already in ${city?.name ?? code}'s ideas.${filled}${pinNote}`, activityId: dup.id };
    }
    const place = s.place ?? null;
    const created = await call<{ id: string; placeStatus?: LibraryActivity["placeStatus"] }>("POST", "/activities", {
      tripId,
      cityCode: code,
      title: s.title,
      tags: s.tags,
      url: s.url,
      costCad: s.costCad,
      // What the place lookup found; absent when it didn't run.
      ...(place?.website ? { website: place.website } : {}),
      ...(place?.ticketUrl ? { ticketUrl: place.ticketUrl } : {}),
      ...(place?.reserveUrl ? { reserveUrl: place.reserveUrl } : {}),
      ...(place?.eventDate ? { when: { on: place.eventDate } } : {}),
    });
    if (s.note) await call("POST", `/activities/${created.id}/comments`, { text: `From the inbox: ${s.note}`.slice(0, 280) });
    let pinNote = "";
    if (place && (place.placeStatus || place.mapsUrl)) {
      await ctx.places.pinFound(
        { id: created.id, placeStatus: created.placeStatus },
        {
          point: place.lat != null && place.lon != null ? { lat: place.lat, lon: place.lon } : null,
          address: place.address ?? null,
          status: place.placeStatus ?? null,
          mapsUrl: place.mapsUrl ?? null,
        },
      );
      ctx.notify(tripId, { kind: "activities" }, actorId);
      if (place.placeStatus === "check") pinNote = " Check the pin on the map.";
      if (place.placeStatus === "not_found") pinNote = " Couldn't find it on the map.";
    }
    return { note: `Added to ${city?.name ?? code}'s ideas.${pinNote}`, activityId: created.id };
  }

  /** Adds an item's suggestion to the trip as `actor`. Failures are recorded on the item, not thrown. */
  async function apply(itemId: string, actor: { id: string; name: string | null }, override?: AcceptBody): Promise<InboxItem> {
    const item = await repos.inbox.get(itemId);
    if (!item) throw badRequest("That inbox item is gone");
    if (item.status === "applied") return item;
    let suggestion = item.suggestion;
    if (!suggestion) throw badRequest("There is nothing to add from this one");
    if (override?.cityCode && suggestion.kind === "activity") suggestion = { ...suggestion, cityCode: override.cityCode };

    const stored = await currentRoute(item.tripId);
    const view = stored ? buildRouteView(stored, "owner") : null;
    const target = matchStop(view, suggestion, override);
    const record = (status: InboxItem["status"], note: string | null, extra: { appliedBy?: string | null; appliedAt?: string | null } = {}) =>
      repos.inbox.update(itemId, {
        status,
        note,
        stopId: target?.id ?? item.stopId,
        stopLabel: target ? stopLabel(target) : item.stopLabel,
        suggestion,
        ...extra,
      });

    try {
      const call = await actingAs(actor);
      let note: string;
      if (suggestion.kind === "activity") {
        if (!suggestion.cityCode) throw new ApplyError("Pick the city this is in first.");
        const added = await addActivity(call, item.tripId, actor.id, suggestion);
        suggestion = { ...suggestion, activityId: added.activityId };
        note = added.note;
      } else {
        if (!stored || !target) throw new ApplyError("Pick a stop on the current route first.");
        note =
          suggestion.kind === "leg"
            ? await addLeg(call, stored.route.id, target, suggestion)
            : await addStay(call, item.tripId, actor.id, stored.route.id, target, suggestion);
      }
      await record("applied", note, { appliedBy: actor.name ?? "Someone", appliedAt: nowIso() });
    } catch (e) {
      if (!(e instanceof ApplyError || e instanceof AppError)) throw e;
      await record("failed", e.message);
    }
    ctx.notify(item.tripId, { kind: "inbox" }, actor.id);
    return (await repos.inbox.get(itemId))!;
  }

  /** Ideas and hotels get a place lookup; tickets and transport pages don't. */
  function needsLookup(s: InboxSuggestion): boolean {
    if (s.kind === "leg") return false;
    if (s.kind === "activity" && s.url && classifyLink(s.url) === "transport") return false;
    return true;
  }

  function lookupInput(s: ActivitySuggestion | StaySuggestion, rctx: ReaderContext, view: RouteView | null, previews: LinkPreview[], message: string): LookupInput {
    const byCode = new Map(rctx.cities.map((c) => [c.code, c]));
    const asCity = (code: string | null | undefined): LookupCity | null => {
      const c = code ? byCode.get(code) : undefined;
      return c ? { code: c.code, name: c.name, countryName: c.countryName } : null;
    };
    const routeCities = [...new Set(view?.stops.map((st) => st.city.code) ?? [])].map(asCity).filter((c): c is LookupCity => c !== null);
    const url = s.url;
    const preview = url ? previews.find((p) => p.url === url) : undefined;
    return {
      kind: s.kind,
      title: s.kind === "activity" ? s.title : [s.hotelName, s.areaName].filter(Boolean).join(", "),
      city: asCity(s.cityCode),
      routeCities,
      link: url ? { url, kind: classifyLink(url), title: preview?.title ?? null, author: preview?.author ?? null } : null,
      note: s.kind === "activity" ? s.note : null,
      message,
    };
  }

  /** The suggestion with what the lookup found; an idea without a city takes the lookup's. */
  function withPlace(s: InboxSuggestion, result: FindOutcome): InboxSuggestion {
    if (s.kind === "leg") return s;
    const cityCode = s.cityCode ?? result.cityCode;
    return { ...s, cityCode, place: result.place };
  }

  /**
   * Runs the lookups for one message side by side, within the per-message
   * budget. A lookup that errors or runs out of time is "failed" and keeps
   * whatever it had; a person can retry it from the inbox.
   */
  async function lookUp(
    entries: { suggestion: InboxSuggestion; input: LookupInput }[],
    messageUrls: string[],
    knownCities: Set<string>,
  ): Promise<Map<InboxSuggestion, { state: InboxLookupState; result: FindOutcome }>> {
    const out = new Map<InboxSuggestion, { state: InboxLookupState; result: FindOutcome }>();
    const lookup = ctx.placeLookup;
    if (!lookup || !entries.length) return out;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_BUDGET_MS);
    const outOfTime = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
    try {
      await Promise.all(
        entries.map(async ({ suggestion, input }) => {
          let result: FindOutcome | null = null;
          try {
            result = await Promise.race([
              findPlace({ lookup, places: ctx.places, repos }, input, { messageUrls, knownCities, signal: controller.signal }),
              outOfTime,
            ]);
          } catch (e) {
            ctx.log.warn({ err: e }, "inbox place lookup failed");
          }
          out.set(suggestion, result ? { state: result.state, result } : { state: "failed", result: { state: "failed", place: null, cityCode: null } });
        }),
      );
    } finally {
      clearTimeout(timer);
    }
    return out;
  }

  /** Reads one message and stores what it found; trusted editors' finds are added straight away. */
  async function receive(msg: Incoming): Promise<InboxItem[]> {
    const text = (msg.text?.trim() || (msg.html ? htmlToText(msg.html) : "")).replace(/\r\n/g, "\n");
    const previews = await previewLinks(findLinks(text), { fetchPreviews: config.INBOX_LINK_PREVIEWS });
    const stored = await currentRoute(msg.tripId);
    const view = stored ? buildRouteView(stored, "owner") : null;
    const rctx = await readerContext(msg.tripId, view);
    const known = new Set(rctx.cities.map((c) => c.code));
    const cityName = (code: string | null) => rctx.cities.find((c) => c.code === code)?.name ?? null;
    const messageId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const base = {
      tripId: msg.tripId,
      messageId,
      source: msg.source,
      from: cut(msg.from, 200),
      fromName: cut(msg.fromName, 120),
      subject: cut(msg.subject, 200),
    };
    const firstLine = cut(text.split("\n").find((l) => l.trim()), 120);

    let found: ExtractedItem[];
    try {
      found = (await ctx.inboxReader.read({ from: msg.from, subject: msg.subject, text, links: previews, pdfs: msg.pdfs ?? [] }, rctx)).items;
    } catch (e) {
      ctx.log.warn({ err: e }, "inbox reader failed");
      const id = await repos.inbox.create({
        ...base,
        kind: "unknown",
        status: "failed",
        summary: base.subject ?? firstLine ?? "Message",
        suggestion: null,
        stopId: null,
        stopLabel: null,
        note: `Couldn't read this: ${e instanceof Error ? e.message : "unknown error"}`,
      });
      ctx.notify(msg.tripId, { kind: "inbox" }, msg.sender?.id ?? "inbox");
      return [(await repos.inbox.get(id))!];
    }

    const truncated = text.length > MAX_BODY_CHARS ? " Only the first part of this long message was read." : "";
    const ids: string[] = [];
    const auto = msg.trusted && msg.sender != null && hasRole(msg.sender.role, "editor");
    const noteFor = (waiting: string | null) => {
      const note = waiting ?? (auto ? null : msg.sender ? "Waiting for an editor to accept it." : `Sent by ${msg.from ?? "someone"}, who isn't on this trip.`);
      return note ? `${note}${truncated}` : truncated.trim() || null;
    };
    const created: Found[] = [];
    let lookups = 0;
    for (const ex of found) {
      const suggestion = toSuggestion(ex, known, previews);
      if (!suggestion) continue;
      const target = matchStop(view, suggestion);
      const waiting = waitingNote(suggestion, target, cityName);
      const lookup = ctx.placeLookup && needsLookup(suggestion) && lookups < MAX_LOOKUPS_PER_MESSAGE;
      if (lookup) lookups++;
      const id = await repos.inbox.create({
        ...base,
        kind: suggestion.kind,
        status: "pending",
        summary: cut(ex.summary, 200) ?? suggestion.kind,
        suggestion,
        stopId: target?.id ?? null,
        stopLabel: target ? stopLabel(target) : null,
        note: noteFor(waiting),
        lookup: lookup ? "pending" : "skipped",
      });
      ids.push(id);
      created.push({ id, suggestion, waiting, lookup: Boolean(lookup) });
    }

    // Find the places behind the links before anything is added, so the activity
    // is created with its links and pin. Everyone watching sees "Finding the place…" meanwhile.
    if (lookups) {
      ctx.notify(msg.tripId, { kind: "inbox" }, msg.sender?.id ?? "inbox");
      const context = { message: [msg.subject, text].filter(Boolean).join("\n"), messageUrls: [...urlsIn(text), ...previews.map((p) => p.url)] };
      const outcomes = await lookUp(
        created.flatMap((c) =>
          c.lookup && c.suggestion.kind !== "leg" ? [{ suggestion: c.suggestion, input: lookupInput(c.suggestion, rctx, view, previews, context.message) }] : [],
        ),
        context.messageUrls,
        known,
      );
      for (const c of created) {
        const outcome = outcomes.get(c.suggestion);
        if (!outcome) continue;
        c.suggestion = withPlace(c.suggestion, outcome.result);
        const target = matchStop(view, c.suggestion);
        c.waiting = waitingNote(c.suggestion, target, cityName);
        await repos.inbox.update(c.id, {
          status: "pending",
          note: noteFor(c.waiting),
          stopId: target?.id ?? null,
          stopLabel: target ? stopLabel(target) : null,
          suggestion: c.suggestion,
          lookup: outcome.state,
        });
      }
    }
    if (auto) {
      for (const c of created) if (!c.waiting) await apply(c.id, { id: msg.sender!.id, name: msg.sender!.name });
    }
    if (!ids.length) {
      ids.push(
        await repos.inbox.create({
          ...base,
          kind: "unknown",
          status: "pending",
          summary: base.subject ?? firstLine ?? "Message",
          suggestion: null,
          stopId: null,
          stopLabel: null,
          note:
            ctx.inboxReader.name === "claude"
              ? `Nothing to add was found in this message.${truncated}`
              : "Only links are recognised until Claude is set up to read bookings. Add this one by hand, or dismiss it.",
        }),
      );
    }
    ctx.notify(msg.tripId, { kind: "inbox" }, msg.sender?.id ?? "inbox");
    return Promise.all(ids.map(async (id) => (await repos.inbox.get(id))!));
  }

  async function dismiss(itemId: string, by: string): Promise<InboxItem> {
    const item = await repos.inbox.get(itemId);
    if (!item) throw badRequest("That inbox item is gone");
    if (item.status !== "applied") {
      await repos.inbox.update(itemId, { status: "dismissed", note: item.note, stopId: item.stopId, stopLabel: item.stopLabel, suggestion: item.suggestion });
    }
    ctx.notify(item.tripId, { kind: "inbox" }, by);
    return (await repos.inbox.get(itemId))!;
  }

  /**
   * Runs the place lookup again for one item ("Couldn't find the place" → Try again).
   * An idea that was already added gets the links it is missing and, unless a
   * person placed it by hand, the new pin.
   */
  async function lookupAgain(itemId: string, actor: { id: string; name: string | null }): Promise<InboxItem> {
    const item = await repos.inbox.get(itemId);
    if (!item) throw badRequest("That inbox item is gone");
    if (!ctx.placeLookup) throw new AppError(503, "unavailable", "Finding places is turned off on this server");
    const suggestion = item.suggestion;
    if (!suggestion || suggestion.kind === "leg") throw badRequest("There is no place to find for this one");
    const keep = { status: item.status, note: item.note, stopId: item.stopId, stopLabel: item.stopLabel, appliedBy: item.appliedBy, appliedAt: item.appliedAt };
    await repos.inbox.update(itemId, { ...keep, suggestion, lookup: "pending" });
    ctx.notify(item.tripId, { kind: "inbox" }, actor.id);

    const stored = await currentRoute(item.tripId);
    const view = stored ? buildRouteView(stored, "owner") : null;
    const rctx = await readerContext(item.tripId, view);
    const message = [item.subject, item.summary].filter(Boolean).join("\n");
    const messageUrls = suggestion.url ? [suggestion.url] : [];
    const outcomes = await lookUp(
      [{ suggestion, input: lookupInput(suggestion, rctx, view, [], message) }],
      messageUrls,
      new Set(rctx.cities.map((c) => c.code)),
    );
    const outcome = outcomes.get(suggestion) ?? { state: "failed" as const, result: { state: "failed" as const, place: null, cityCode: null } };
    // A failed retry keeps what an earlier lookup found.
    const updated = outcome.state === "done" ? withPlace(suggestion, outcome.result) : suggestion;
    await repos.inbox.update(itemId, { ...keep, suggestion: updated, lookup: outcome.state });

    const place = updated.kind === "activity" ? updated.place : null;
    if (outcome.state === "done" && updated.kind === "activity" && updated.activityId && place && item.status === "applied") {
      const call = await actingAs(actor);
      await enrichActivity(call, item.tripId, actor.id, updated.activityId, place, updated.url);
    }
    ctx.notify(item.tripId, { kind: "inbox" }, actor.id);
    return (await repos.inbox.get(itemId))!;
  }

  return { receive, apply, dismiss, lookupAgain };
}

export type Inbox = ReturnType<typeof createInbox>;
