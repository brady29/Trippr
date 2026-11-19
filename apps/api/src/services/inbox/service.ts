import {
  hasRole,
  type AcceptBody,
  type ActivitySuggestion,
  type InboxItem,
  type InboxSource,
  type InboxSuggestion,
  type LegSuggestion,
  type Role,
  type RouteView,
  type StaySuggestion,
  type StopView,
} from "@trippr/contracts";
import type { AppContext } from "../../app";
import { AppError, badRequest } from "../../errors";
import { nowIso } from "../../ids";
import type { StoredRoute } from "../../repositories";
import { buildRouteView } from "../route-view";
import { findLinks, htmlToText, previewLinks, type LinkPreview } from "./links";
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
    return async <T = unknown>(method: "GET" | "POST" | "PUT", url: string, payload?: object): Promise<T> => {
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
      hotel = await call("POST", "/hotels", {
        tripId,
        areaId: area!.id,
        name: s.hotelName,
        url: s.url,
        priceCadPerNight: s.perNightCad,
        priceBasis: "room",
        sleeps: 2,
      });
    }
    const existing = stop.stays.find((st) => st.hotel.id === hotel!.id);
    if (existing?.status === "booked") return `${s.hotelName} is already booked for ${stopLabel(stop)}.`;
    await withVersion(routeId, (version) =>
      call("PUT", `/stops/${stop.id}/stays/${hotel!.id}`, { status: s.status, ...(s.rooms ? { rooms: s.rooms } : {}), version }),
    );
    const dates =
      s.checkIn && s.checkOut && (s.checkIn !== stop.arrive || s.checkOut !== stop.depart)
        ? ` The booking is ${shortDay(s.checkIn)} to ${shortDay(s.checkOut)}; the stop is ${shortDay(stop.arrive)} to ${shortDay(stop.depart)}.`
        : "";
    return `Added to ${stopLabel(stop)} as ${s.status}.${dates}`;
  }

  async function addActivity(call: Call, tripId: string, s: ActivitySuggestion): Promise<string> {
    const code = s.cityCode!;
    const existing = await call<{ id: string; title: string; url?: string | null }[]>("GET", `/cities/${code}/activities?tripId=${encodeURIComponent(tripId)}`);
    const city = await repos.cities.get(code);
    const dup = existing.find((a) => (s.url && a.url === s.url) || norm(a.title) === norm(s.title));
    if (dup) return `${dup.title} is already in ${city?.name ?? code}'s ideas.`;
    const created = await call<{ id: string }>("POST", "/activities", {
      tripId,
      cityCode: code,
      title: s.title,
      tags: s.tags,
      url: s.url,
      costCad: s.costCad,
    });
    if (s.note) await call("POST", `/activities/${created.id}/comments`, { text: `From the inbox: ${s.note}`.slice(0, 280) });
    return `Added to ${city?.name ?? code}'s ideas.`;
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
        note = await addActivity(call, item.tripId, suggestion);
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
    for (const ex of found) {
      const suggestion = toSuggestion(ex, known, previews);
      if (!suggestion) continue;
      const target = matchStop(view, suggestion);
      const waiting = waitingNote(suggestion, target, cityName);
      const note = waiting ?? (auto ? null : msg.sender ? "Waiting for an editor to accept it." : `Sent by ${msg.from ?? "someone"}, who isn't on this trip.`);
      const id = await repos.inbox.create({
        ...base,
        kind: suggestion.kind,
        status: "pending",
        summary: cut(ex.summary, 200) ?? suggestion.kind,
        suggestion,
        stopId: target?.id ?? null,
        stopLabel: target ? stopLabel(target) : null,
        note: note ? `${note}${truncated}` : truncated.trim() || null,
      });
      ids.push(id);
      if (auto && !waiting) await apply(id, { id: msg.sender!.id, name: msg.sender!.name });
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

  return { receive, apply, dismiss };
}

export type Inbox = ReturnType<typeof createInbox>;
