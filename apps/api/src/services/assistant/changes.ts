import {
  ASSISTANT_MAX_PROPOSALS,
  PROPOSAL_STALE_MESSAGE,
  type AssistantProposal,
  type AssistantProposalTarget,
  type AssistantTurn,
  type FoundPlace,
  type Hub,
  type LibraryActivity,
  type RouteView,
} from "@trippr/contracts";
import { classifyLink, urlsIn } from "@trippr/rules";
import type { AppContext } from "../../app";
import type { AuthUser } from "../../auth";
import { AppError, badRequest, notFound } from "../../errors";
import { newId, nowIso } from "../../ids";
import type { AssistantRepository } from "../../repositories/assistant";
import { findPlace, LOOKUP_BUDGET_MS, type LookupCity, type LookupInput } from "../inbox/lookup";
import {
  advanceVersions,
  checkProposal,
  describePlace,
  findProposal,
  hubKey,
  hubKind,
  markStale,
  openRouteIds,
  parseProposeInput,
  updateProposal,
  type CheckedProposal,
  type Dropped,
  type ProposalFacts,
  type ProposalInput,
} from "./proposals";
import { ToolError, type CallAs } from "./tools";

/** What propose_changes needs while one question is answered. */
export interface ProposeContext {
  tripId: string;
  call: CallAs;
  currentRouteId: string | null;
  routeIds: string[];
  /** The member's question, for the place lookup's context. */
  question: string;
  /** Suggestions made so far in this answer; new ones are added here. */
  made: AssistantProposal[];
}

const enc = encodeURIComponent;
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Station kinds that suit each travel mode, best first. */
const STATION_KIND: Record<string, string[]> = { hsr: ["hsr", "rail"], train: ["rail", "hsr"], maglev: ["maglev"], boat: ["ferry"], road: [] };

/**
 * Suggested changes, the part that talks to the API: checking suggestions as
 * the editor sees the trip (and finding the place behind new ideas), then
 * Apply and Dismiss. Apply sends the normal API requests in-process as the
 * editor, so role checks, validation, version locking and live updates
 * behave exactly as if they had made the change by hand.
 */
export function createProposals(ctx: AppContext, repo: AssistantRepository) {
  const { repos } = ctx;

  async function hubsFor(items: ProposalInput[]): Promise<Map<string, Hub>> {
    const hubs = new Map<string, Hub>();
    const legs = items.filter((p) => p.kind === "add_leg");
    const ids = [...new Set(legs.flatMap((p) => [p.from.hubId, p.to.hubId]).filter((x): x is string => Boolean(x)))];
    if (ids.length) for (const [hubId, hub] of await repos.explorer.getHubs(ids)) hubs.set(`hub:${hubId}`, hub);
    for (const p of legs) {
      for (const side of [p.from, p.to]) {
        if (side.hubId || !side.cityCode) continue;
        const key = hubKey(side, p.mode);
        if (hubs.has(key)) continue;
        const found = await repos.explorer.searchHubs({ q: "", city: side.cityCode.toUpperCase(), kind: hubKind(p.mode), limit: 50 });
        const preferred = STATION_KIND[p.mode] ?? [];
        const best = preferred.map((k) => found.find((h) => h.stationKind === k)).find(Boolean) ?? found[0];
        if (best) hubs.set(key, best);
      }
    }
    return hubs;
  }

  /** Runs the Feature 4 place lookup for new ideas, side by side, within the inbox's time budget. */
  async function lookUp(found: { checked: CheckedProposal }[], view: RouteView, question: string): Promise<Map<CheckedProposal, FoundPlace>> {
    const out = new Map<CheckedProposal, FoundPlace>();
    const lookup = ctx.placeLookup;
    const ideas = found.filter((f) => f.checked.change.kind === "add_activity");
    if (!lookup || !ideas.length) return out;
    const routeCities: LookupCity[] = [...new Map(view.stops.map((s) => [s.city.code, { code: s.city.code, name: s.city.name, countryName: s.country.name }])).values()];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_BUDGET_MS);
    const outOfTime = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
    try {
      await Promise.all(
        ideas.map(async ({ checked }) => {
          const change = checked.change;
          if (change.kind !== "add_activity") return;
          const city = await repos.cities.get(change.cityCode);
          if (!city) return;
          const input: LookupInput = {
            kind: "activity",
            title: change.title,
            city: { code: city.code, name: city.name, countryName: city.countryName },
            routeCities,
            link: change.url ? { url: change.url, kind: classifyLink(change.url), title: null, author: null } : null,
            note: change.note,
            message: question.slice(0, 4000),
          };
          try {
            const result = await Promise.race([
              findPlace({ lookup, places: ctx.places, repos }, input, {
                // Only links the member wrote back up what the lookup reports.
                messageUrls: urlsIn(question),
                knownCities: new Set([city.code]),
                signal: controller.signal,
              }),
              outOfTime,
            ]);
            if (result?.place) out.set(checked, result.place);
          } catch (err) {
            ctx.log.warn({ err }, "assistant place lookup failed");
          }
        }),
      );
    } finally {
      clearTimeout(timer);
    }
    return out;
  }

  /**
   * The propose_changes tool. Writes nothing: checks each suggestion against
   * the route and library as the editor sees them, drops the ones that don't
   * fit (with the reason, for the model), and records the rest as open
   * proposals on this answer. Returns what the model reads.
   */
  async function propose(input: unknown, pc: ProposeContext): Promise<unknown> {
    const parsed = parseProposeInput(input, ASSISTANT_MAX_PROPOSALS - pc.made.length);
    if ("error" in parsed) throw new ToolError(parsed.error);
    const routeId = parsed.routeId ?? pc.currentRouteId;
    if (!routeId) throw new ToolError("This trip has no routes yet.");
    if (!pc.routeIds.includes(routeId)) throw new ToolError(`No route ${routeId} in this trip. Route ids: ${pc.routeIds.join(", ")}.`);
    const items = parsed.items.map((i) => i.proposal);
    const needsLibrary = items.some((p) => p.kind === "add_activity" || p.kind === "plan_activity");
    const [view, activities] = await Promise.all([
      pc.call<RouteView>(`/routes/${enc(routeId)}`),
      needsLibrary ? pc.call<LibraryActivity[]>(`/trips/${enc(pc.tripId)}/activities`) : Promise.resolve([] as LibraryActivity[]),
    ]);
    const codes = new Set<string>();
    for (const p of items) {
      if (p.kind === "add_activity" || p.kind === "add_stop") codes.add(p.cityCode.toUpperCase());
      if (p.kind === "add_leg") for (const side of [p.from, p.to]) if (side.cityCode) codes.add(side.cityCode.toUpperCase());
    }
    const cities = new Map<string, { code: string; name: string }>();
    await Promise.all(
      [...codes].map(async (c) => {
        const city = await repos.cities.get(c);
        if (city) cities.set(c, { code: city.code, name: city.name });
      }),
    );
    const facts: ProposalFacts = { view, activities, cities, hubs: await hubsFor(items) };

    const dropped: Dropped[] = [...parsed.dropped];
    const accepted: { n: number; checked: CheckedProposal }[] = [];
    for (const { n, proposal } of parsed.items) {
      const checked = checkProposal(proposal, facts);
      if ("reason" in checked) dropped.push({ n, kind: proposal.kind, reason: checked.reason });
      else accepted.push({ n, checked });
    }
    const places = await lookUp(accepted, view, pc.question);

    const made = accepted.map(({ checked }): AssistantProposal => {
      const place = places.get(checked);
      const change = checked.change.kind === "add_activity" && place ? { ...checked.change, place } : checked.change;
      return {
        id: newId("prop"),
        kind: checked.kind,
        routeId: checked.routeId,
        version: checked.version,
        summary: checked.summary,
        detail: describePlace(place),
        status: "open",
        note: null,
        change,
      };
    });
    pc.made.push(...made);
    dropped.sort((a, b) => a.n - b.n);
    return {
      suggested: made.map((p) => ({ id: p.id, summary: p.summary, detail: p.detail })),
      dropped,
      note: made.length
        ? "The member sees each suggestion as a card with Apply and Dismiss. Nothing has changed yet: don't say it has. Mention briefly what you suggested."
        : "Nothing was suggested.",
    };
  }

  // --- apply and dismiss --------------------------------------------------------

  /** A request against this API as `user`, returning the status and body instead of throwing. */
  async function asUser(user: AuthUser) {
    const token = await ctx.auth.issue({ id: user.id, name: user.name ?? null }, "5m");
    return async <T = unknown>(method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object): Promise<T> => {
      const res = await ctx.inject({ method, url, ...(payload ? { payload } : {}), headers: { authorization: `Bearer ${token}` } });
      let body: { error?: { code?: string; message?: string } } | undefined;
      try {
        body = res.json() as typeof body;
      } catch {
        body = undefined;
      }
      if (res.statusCode >= 400) {
        const code = res.statusCode === 409 ? "version_conflict" : res.statusCode === 403 ? "forbidden" : res.statusCode === 404 ? "not_found" : "bad_request";
        throw new AppError(res.statusCode, code, body?.error?.message ?? `Request failed (${res.statusCode})`);
      }
      return body as T;
    };
  }

  /** Saves a change to the member's thread, on top of whatever is stored now. */
  async function save(user: AuthUser, tripId: string, change: (turns: AssistantTurn[]) => AssistantTurn[]): Promise<AssistantTurn[]> {
    const next = change(await repo.turns(user.id, tripId));
    await repo.save(user.id, tripId, next);
    return next;
  }

  type Outcome = { note: string | null; target: AssistantProposalTarget; view?: RouteView };

  async function run(call: Awaited<ReturnType<typeof asUser>>, user: AuthUser, tripId: string, p: AssistantProposal): Promise<Outcome> {
    const change = p.change;
    const routeId = p.routeId!;
    const version = p.version!;
    switch (change.kind) {
      case "add_activity": {
        const existing = await call<LibraryActivity[]>("GET", `/cities/${enc(change.cityCode)}/activities?tripId=${enc(tripId)}`);
        const dup = existing.find((a) => norm(a.title) === norm(change.title));
        if (dup) throw badRequest(`"${dup.title}" is already one of ${dup.cityName}'s ideas.`);
        const place = change.place ?? null;
        const created = await call<LibraryActivity>("POST", "/activities", {
          tripId,
          cityCode: change.cityCode,
          title: change.title,
          tags: change.tags,
          url: change.url,
          // What the place lookup found; absent when it didn't run.
          ...(place?.website ? { website: place.website } : {}),
          ...(place?.ticketUrl ? { ticketUrl: place.ticketUrl } : {}),
          ...(place?.reserveUrl ? { reserveUrl: place.reserveUrl } : {}),
          ...(place?.eventDate ? { when: { on: place.eventDate } } : {}),
        });
        if (change.note) await call("POST", `/activities/${enc(created.id)}/comments`, { text: change.note.slice(0, 280) });
        let note = `Added to ${created.cityName}'s ideas.`;
        // The pin follows the inbox's rules: the geocoder's point, "placed" only when the lookup was confident.
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
          ctx.notify(tripId, { kind: "activities" }, user.id);
          if (place.placeStatus === "check") note += " Check the pin on the map.";
          if (place.placeStatus === "not_found") note += " Couldn't find it on the map.";
        }
        return { note, target: { kind: "map", focus: [`act:${created.id}`] } };
      }
      case "plan_activity": {
        // Planning needs no version in the API; apply() checked it just before.
        const view = await call<RouteView>("PUT", `/stops/${enc(change.stopId)}/plans/${enc(change.activityId)}`, {
          ...(change.day !== undefined ? { day: change.day } : {}),
          ...(change.startTime !== undefined ? { startTime: change.startTime } : {}),
          ...(change.durationMin !== undefined ? { durationMin: change.durationMin } : {}),
        });
        return { note: null, target: { kind: "itinerary", routeId }, view };
      }
      case "set_nights": {
        const view = await call<RouteView>("PATCH", `/stops/${enc(change.stopId)}`, { nights: change.nights, version });
        return { note: null, target: { kind: "route", routeId }, view };
      }
      case "add_stop": {
        const current = await call<RouteView>("GET", `/routes/${enc(routeId)}`);
        const after = change.afterStopId ? current.stops.findIndex((s) => s.id === change.afterStopId) : -1;
        if (change.afterStopId && after < 0) throw new AppError(409, "version_conflict", PROPOSAL_STALE_MESSAGE);
        const view = await call<RouteView>("POST", `/routes/${enc(routeId)}/stops`, {
          cityCode: change.cityCode,
          nights: change.nights,
          ...(change.afterStopId ? { position: after + 1 } : {}),
          version,
        });
        return { note: null, target: { kind: "route", routeId }, view };
      }
      case "add_leg": {
        const view = await call<RouteView>("POST", `/stops/${enc(change.stopId)}/legs`, {
          mode: change.mode,
          from: change.from,
          to: change.to,
          operator: change.operator,
          number: change.number,
          departAt: change.departAt,
          arriveAt: change.arriveAt,
          status: "idea",
          version,
        });
        return { note: null, target: { kind: "route", routeId }, view };
      }
    }
  }

  return {
    propose,

    /**
     * Applies one of the member's open suggestions as them. A version conflict
     * (the route changed since) marks it stale; any other refusal marks it
     * failed with the API's message.
     */
    async apply(user: AuthUser, tripId: string, proposalId: string): Promise<AssistantProposal> {
      const proposal = findProposal(await repo.turns(user.id, tripId), proposalId);
      if (!proposal) throw notFound("Suggestion");
      if (proposal.status === "applied" || proposal.status === "stale") return proposal;
      if (proposal.status !== "open") throw badRequest(proposal.status === "dismissed" ? "That suggestion was dismissed. Ask again." : "That suggestion couldn't be applied. Ask again.");

      let result: AssistantProposal;
      let outcome: Outcome | null = null;
      try {
        const call = await asUser(user);
        if (proposal.routeId) {
          // The route it was made against must still be at that version.
          const view = await call<RouteView>("GET", `/routes/${enc(proposal.routeId)}`).catch((e: unknown) => {
            if (e instanceof AppError && e.status === 404) throw new AppError(409, "version_conflict", "That route was deleted.");
            throw e;
          });
          if (view.route.version !== proposal.version) throw new AppError(409, "version_conflict", PROPOSAL_STALE_MESSAGE);
        }
        outcome = await run(call, user, tripId, proposal);
        result = { ...proposal, status: "applied", note: outcome.note, target: outcome.target, appliedAt: nowIso() };
      } catch (e) {
        if (!(e instanceof AppError) || e.status >= 500 || e.status === 401 || e.status === 403) throw e;
        result =
          e.status === 409
            ? { ...proposal, status: "stale", note: e.message === "That route was deleted." ? e.message : PROPOSAL_STALE_MESSAGE }
            : { ...proposal, status: "failed", note: e.message };
      }

      const newVersion = outcome?.view?.route.version;
      const saved = await save(user, tripId, (turns) => {
        // A second click that lost the race keeps the first one's result.
        const next = updateProposal(turns, proposalId, (stored) => (stored.status === "open" ? result : stored));
        return proposal.routeId && proposal.version != null && newVersion != null
          ? advanceVersions(next, proposal.routeId, proposal.version, newVersion)
          : next;
      });
      return findProposal(saved, proposalId) ?? result;
    },

    async dismiss(user: AuthUser, tripId: string, proposalId: string): Promise<AssistantProposal> {
      const turns = await repo.turns(user.id, tripId);
      const proposal = findProposal(turns, proposalId);
      if (!proposal) throw notFound("Suggestion");
      if (proposal.status !== "open" && proposal.status !== "stale") return proposal;
      const result: AssistantProposal = { ...proposal, status: "dismissed" };
      const saved = await save(user, tripId, (latest) =>
        updateProposal(latest, proposalId, (stored) => (stored.status === "open" || stored.status === "stale" ? result : stored)),
      );
      return findProposal(saved, proposalId) ?? result;
    },

    /** Marks open suggestions stale where their route moved on; saves when anything changed. */
    async refresh(user: AuthUser, tripId: string, turns: AssistantTurn[]): Promise<AssistantTurn[]> {
      const ids = openRouteIds(turns);
      if (!ids.length) return turns;
      const versions = new Map<string, number | null>();
      await Promise.all(
        ids.map(async (routeId) => {
          const stored = await repos.routes.load(routeId);
          versions.set(routeId, stored && stored.trip.id === tripId ? stored.route.version : null);
        }),
      );
      const next = markStale(turns, versions);
      if (!next) return turns;
      await repo.save(user.id, tripId, next);
      return next;
    },
  };
}

export type Proposals = ReturnType<typeof createProposals>;
