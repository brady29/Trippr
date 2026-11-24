import { createHash } from "node:crypto";
import type { ActivitySource, BundleEnrichment, BundlePlace } from "@trippr/contracts";
import { isCatalogueId, planAdoptions } from "@trippr/rules";
import { nowIso } from "../../ids";
import type { Repositories } from "../../repositories";
import type { ExistingActivity, PlaceRow, SourceLink } from "../../repositories/catalogue";
import type { LoadedBundle } from "./bundle";

export interface LoadSummary {
  bundleDate: string;
  dryRun: boolean;
  tripId: string;
  places: number;
  /** New catalogue places added as ideas. */
  created: number;
  /** Catalogue places already in the graph whose pipeline fields changed. */
  refreshed: number;
  unchanged: number;
  /** Hand-written activities matched to a catalogue place (they keep their id, votes and plans). */
  adopted: { activityId: string; placeId: string; title: string }[];
  /** Places the new bundle dropped that the group used: kept, marked "no longer listed". */
  unlisted: number;
  /** Places the new bundle dropped that nobody used: removed. */
  removed: number;
  /** Places the group deleted, which stay deleted. */
  skippedHidden: number;
}

export interface LoadOptions {
  tripId: string;
  dryRun?: boolean;
  now?: () => string;
}

const sourceKey = (s: { source: string; source_id: string }) => `${s.source}:${s.source_id}`;
const keysOf = (p: BundlePlace) => [...p.sources.map(sourceKey), ...(p.wikidata_qid ? [`wikidata:${p.wikidata_qid}`] : [])];

/** The place's content as the graph stores it (not the bundle date), so an unchanged place is not rewritten. */
function hashOf(p: BundlePlace, e?: BundleEnrichment): string {
  const content: unknown[] = [
    p.name, p.name_en, p.name_local, p.category, p.tag, p.score, p.rank, p.n_sources, p.lat, p.lon, p.address, p.website,
    p.phone, p.opening_hours, p.wikidata_qid, p.sources.map((s) => [s.source, s.source_id, s.licence, s.fetched_at]),
  ];
  // Only when there is enrichment, so a place without it keeps the hash it had before enrichment existed.
  if (e) {
    content.push([
      e.tags, e.summary, e.duration_min, e.best_time, e.indoor, e.price_level, e.good_for, e.display_name, e.is_generic_name, e.ai_label,
      e.provenance.summary_ai, e.provenance.model, e.provenance.prompt_version, e.provenance.enriched_at,
    ]);
  }
  return createHash("sha1").update(JSON.stringify(content)).digest("hex");
}

/** The enrichment columns of a PlaceRow. Empty lists and empty summaries become null. */
function enrichmentColumns(e?: BundleEnrichment): Pick<PlaceRow, "enriched" | "summary" | "summaryAi" | "aiLabel" | "enrichTags" | "durationMin" | "bestTime" | "indoor" | "priceLevel" | "goodFor" | "displayName" | "genericName" | "enrichModel" | "enrichPromptVersion" | "enrichedAt"> {
  const summary = e?.summary.trim() ? e.summary.trim() : null;
  return {
    enriched: Boolean(e),
    summary,
    // The label only travels with a summary the model wrote.
    summaryAi: Boolean(e && summary && e.provenance.summary_ai),
    aiLabel: summary && e ? e.ai_label : null,
    enrichTags: e && e.tags.length ? e.tags : null,
    durationMin: e?.duration_min ?? null,
    bestTime: e?.best_time ?? null,
    indoor: e?.indoor ?? null,
    priceLevel: e?.price_level ?? null,
    goodFor: e && e.good_for.length ? e.good_for : null,
    displayName: e?.display_name ?? null,
    genericName: Boolean(e?.is_generic_name),
    enrichModel: e?.provenance.model ?? null,
    enrichPromptVersion: e?.provenance.prompt_version ?? null,
    enrichedAt: e?.provenance.enriched_at ?? null,
  };
}

function toRow(p: BundlePlace, activityId: string, bundleDate: string, now: string, enrichment?: BundleEnrichment): PlaceRow {
  const sources: ActivitySource[] = p.sources.map((s) => ({ source: s.source, sourceId: s.source_id, licence: s.licence }));
  // English name first for the group; the local-script name stays searchable.
  const title = p.name_en ?? p.name;
  return {
    id: p.id,
    activityId,
    catalogueId: p.id,
    cityCode: p.city_code,
    title,
    category: p.category,
    tag: p.tag,
    score: p.score,
    rank: p.rank,
    nSources: p.n_sources,
    lat: p.lat,
    lon: p.lon,
    address: p.address,
    website: p.website,
    phone: p.phone,
    openingHours: p.opening_hours,
    nameLocal: p.name_local ?? (p.name !== title ? p.name : null),
    wikidataQid: p.wikidata_qid,
    sources: JSON.stringify(sources),
    sourceKeys: keysOf(p),
    sourceIds: [...new Set(p.sources.map((s) => s.source))],
    contentHash: hashOf(p, enrichment),
    bundleDate,
    now,
    ...enrichmentColumns(enrichment),
  };
}

/** Did the group use this? (voted, commented, planned, edited, or put the pin there by hand.) */
const engaged = (a: ExistingActivity) => a.votes + a.plans + a.comments > 0 || a.edited || a.placeStatus === "manual";

export interface LoadPlan {
  create: PlaceRow[];
  refresh: PlaceRow[];
  adopt: PlaceRow[];
  unchanged: number;
  unlist: string[];
  remove: string[];
  skippedHidden: number;
  adopted: LoadSummary["adopted"];
}

/**
 * Decide what the bundle changes. Nothing is written here.
 * - A place already in the graph (same id, or sharing a source record) is refreshed in place.
 * - A hand-written activity that is the same place keeps everything and only has its empty fields filled.
 * - Anything else is a new idea.
 * - Catalogue places missing from the bundle are removed, unless the group used them: then they are
 *   kept and marked no longer listed.
 */
export function planLoad(existing: ExistingActivity[], bundle: LoadedBundle, now: string): LoadPlan {
  const byCatalogueId = new Map<string, ExistingActivity>();
  const byKey = new Map<string, ExistingActivity>();
  for (const a of existing) {
    if (!(a.catalogue || a.adopted)) continue;
    byCatalogueId.set(a.catalogueId ?? a.id, a);
    for (const k of a.sourceKeys) if (!byKey.has(k)) byKey.set(k, a);
  }
  const used = new Set<string>();
  const plan: LoadPlan = { create: [], refresh: [], adopt: [], unchanged: 0, unlist: [], remove: [], skippedHidden: 0, adopted: [] };
  const unmatched: BundlePlace[] = [];

  for (const place of bundle.places) {
    const match = [byCatalogueId.get(place.id), ...keysOf(place).map((k) => byKey.get(k))].find((a) => a && !used.has(a.id));
    if (!match) {
      unmatched.push(place);
      continue;
    }
    used.add(match.id);
    const row = toRow(place, match.id, bundle.date, now, bundle.enrichment.get(place.id));
    if (match.hidden) plan.skippedHidden++;
    else if (match.contentHash === row.contentHash && match.listed) plan.unchanged++;
    else (match.adopted ? plan.adopt : plan.refresh).push(row);
  }

  const handWritten = existing.filter((a) => !a.catalogue && !a.adopted && !a.hidden && !isCatalogueId(a.id));
  const placeById = new Map(unmatched.map((p) => [p.id, p]));
  const adoptions = planAdoptions(
    handWritten.map((a) => ({ id: a.id, cityCode: a.cityCode, cityName: a.cityName, title: a.title, mapsQuery: a.mapsQuery, lat: a.lat, lon: a.lon })),
    unmatched.map((p) => ({ id: p.id, cityCode: p.city_code, names: [p.name, p.name_en, p.name_local].filter((n): n is string => Boolean(n)), lat: p.lat, lon: p.lon, rank: p.rank })),
  );
  const adoptedPlaces = new Set<string>();
  for (const { activityId, placeId } of adoptions) {
    const place = placeById.get(placeId)!;
    adoptedPlaces.add(placeId);
    plan.adopt.push(toRow(place, activityId, bundle.date, now, bundle.enrichment.get(place.id)));
    plan.adopted.push({ activityId, placeId, title: handWritten.find((a) => a.id === activityId)?.title ?? activityId });
  }
  for (const place of unmatched) if (!adoptedPlaces.has(place.id)) plan.create.push(toRow(place, place.id, bundle.date, now, bundle.enrichment.get(place.id)));

  for (const a of existing) {
    if (!a.catalogue || a.hidden || used.has(a.id)) continue;
    if (engaged(a)) {
      if (a.listed) plan.unlist.push(a.id);
    } else plan.remove.push(a.id);
  }
  return plan;
}

/** Resolve the trip the catalogue belongs to: the one asked for, or the only trip there is. */
export async function resolveTrip(repos: Repositories, requested?: string | null): Promise<string> {
  const trips = await repos.catalogue.trips();
  if (requested) {
    if (!trips.some((t) => t.id === requested)) throw new Error(`There is no trip "${requested}" in this database`);
    return requested;
  }
  if (trips.length === 0) throw new Error("There is no trip to add places to; seed the database first");
  if (trips.length > 1) throw new Error(`Several trips exist (${trips.map((t) => t.id).join(", ")}); say which one gets the catalogue with --trip`);
  return trips[0]!.id;
}

/**
 * Put a bundle in the graph. Idempotent: running it again with the same bundle changes nothing; with a
 * newer one it refreshes. Never deletes or overwrites votes, comments, plans, trip data, edited text or pins
 * placed by hand.
 */
export async function loadBundle(repos: Repositories, bundle: LoadedBundle, options: LoadOptions): Promise<LoadSummary> {
  const now = (options.now ?? nowIso)();
  const existing = await repos.catalogue.existing();
  const plan = planLoad(existing, bundle, now);
  const summary: LoadSummary = {
    bundleDate: bundle.date,
    dryRun: Boolean(options.dryRun),
    tripId: options.tripId,
    places: bundle.places.length,
    created: plan.create.length,
    refreshed: plan.refresh.length,
    unchanged: plan.unchanged,
    adopted: plan.adopted,
    unlisted: plan.unlist.length,
    removed: plan.remove.length,
    skippedHidden: plan.skippedHidden,
  };
  if (options.dryRun) return summary;

  await repos.catalogue.upsertSources(
    bundle.sources.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      licence: s.licence,
      licenceDetail: s.licence_detail,
      licenceUrls: s.licence_urls,
      attribution: s.attribution,
      termsCheckedOn: s.terms_checked_on,
      allowedUses: s.allowed_uses,
      enabled: s.enabled,
      version: s.version,
      fetchedAt: s.fetched_at,
      stagedRows: s.staged_rows,
    })),
    now,
  );
  await repos.catalogue.create(options.tripId, plan.create);
  await repos.catalogue.refresh(plan.refresh);
  await repos.catalogue.adopt(plan.adopt);

  const placeOf = new Map(bundle.places.map((p) => [p.id, p]));
  const touched = [...plan.create, ...plan.refresh, ...plan.adopt];
  const links: SourceLink[] = touched.flatMap((row) =>
    placeOf.get(row.catalogueId)!.sources.map((s) => ({ activityId: row.activityId, source: s.source, sourceId: s.source_id, fetchedAt: s.fetched_at, licence: s.licence })),
  );
  await repos.catalogue.replaceSourceLinks(touched.map((r) => r.activityId), links);
  await repos.catalogue.unlist(plan.unlist, now);
  await repos.catalogue.remove(plan.remove);

  const { manifest } = bundle;
  await repos.catalogue.recordLoad({
    id: bundle.date,
    bundleDate: bundle.date,
    now,
    input: manifest.input,
    pipelineVersion: manifest.pipeline_version,
    createdAt: manifest.created_at,
    counts: JSON.stringify({
      places: manifest.counts.places,
      cities: manifest.counts.cities,
      created: summary.created,
      updated: summary.refreshed,
      adopted: summary.adopted.length,
      unlisted: summary.unlisted,
      byTag: manifest.counts.by_tag,
      byCategory: manifest.counts.by_category,
      enrichment: manifest.enrichment
        ? {
            places: manifest.enrichment.places,
            withSummary: manifest.enrichment.with_summary,
            models: manifest.enrichment.models,
            promptVersions: manifest.enrichment.prompt_versions,
            enrichedAt: manifest.enrichment.enriched_at,
            sourceDate: manifest.enrichment.source_date,
          }
        : null,
    }),
    checks: JSON.stringify(manifest.checks),
    evals: JSON.stringify(manifest.evals),
  });
  return summary;
}
