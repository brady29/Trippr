import type { GraphClient } from "../db/graph";
import { cypher } from "./queries";
import { num } from "./util";

/** An activity as the load job sees it: what it is and how much the group has used it. */
export interface ExistingActivity {
  id: string;
  title: string;
  mapsQuery: string | null;
  lat: number | null;
  lon: number | null;
  placeStatus: string | null;
  geoSource: string | null;
  /** Created by the load job (a catalogue place). */
  catalogue: boolean;
  /** Written by the group, then matched to a catalogue place. */
  adopted: boolean;
  /** The bundle id of the place this activity is, when it came from or was matched to one. */
  catalogueId: string | null;
  sourceKeys: string[];
  listed: boolean;
  /** Deleted by the group; the load job leaves it alone. */
  hidden: boolean;
  /** A person edited its text. */
  edited: boolean;
  contentHash: string | null;
  cityCode: string;
  cityName: string;
  votes: number;
  plans: number;
  comments: number;
}

/** A row for catalogue/create, refresh and adopt: the pipeline's fields for one place. */
export interface PlaceRow {
  id: string;
  /** The existing activity to refresh or adopt into (differs from `id` for hand-written ones). */
  activityId: string;
  catalogueId: string;
  cityCode: string;
  title: string;
  category: string;
  tag: string;
  score: number;
  rank: number;
  nSources: number;
  lat: number;
  lon: number;
  address: string | null;
  website: string | null;
  phone: string | null;
  openingHours: string | null;
  nameLocal: string | null;
  wikidataQid: string | null;
  /** JSON: [{ source, sourceId, licence }]. */
  sources: string;
  sourceKeys: string[];
  sourceIds: string[];
  contentHash: string;
  bundleDate: string;
  now: string;
  /**
   * LLM enrichment. false = the bundle has none for this place: the graph's own is left as it is.
   * Lists are null, not empty (an empty array is not stored as a property).
   */
  enriched: boolean;
  summary: string | null;
  /** The summary was written by a model; the app labels it. */
  summaryAi: boolean;
  aiLabel: string | null;
  enrichTags: string[] | null;
  durationMin: number | null;
  bestTime: string | null;
  indoor: boolean | null;
  priceLevel: string | null;
  goodFor: string[] | null;
  displayName: string | null;
  genericName: boolean;
  enrichModel: string | null;
  enrichPromptVersion: string | null;
  enrichedAt: string | null;
}

export interface SourceRow {
  id: string;
  name: string;
  url: string;
  licence: string;
  licenceDetail: string | null;
  licenceUrls: string[];
  attribution: string;
  termsCheckedOn: string;
  allowedUses: string[];
  enabled: boolean;
  version: string | null;
  fetchedAt: string | null;
  stagedRows: number | null;
}

export interface SourceLink {
  activityId: string;
  source: string;
  sourceId: string;
  fetchedAt: string;
  licence: string;
}

export interface LoadRecord {
  id: string;
  bundleDate: string;
  now: string;
  input: string;
  pipelineVersion: string;
  createdAt: string;
  counts: string;
  checks: string;
  evals: string;
}

const BATCH = 400;

async function inBatches<T>(rows: T[], run: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += BATCH) await run(rows.slice(i, i + BATCH));
}

/** The load job's reads and writes. Everything it does to the graph is in the catalogue/*.cypher files. */
export function catalogueRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const read = { readOnly: true };

  return {
    async trips(): Promise<{ id: string; name: string }[]> {
      return db.query<{ id: string; name: string }>(q("catalogue/trips"), {}, read);
    },

    async existing(): Promise<ExistingActivity[]> {
      const rows = await db.query<{
        activity: Record<string, unknown> & { id: string; title: string };
        cityCode: string;
        cityName: string;
        votes: unknown;
        plans: unknown;
        comments: unknown;
      }>(q("catalogue/existing"), {}, read);
      return rows.map((r) => {
        const a = r.activity;
        const opt = (v: unknown) => (v == null ? null : num(v));
        return {
          id: a.id,
          title: a.title,
          mapsQuery: (a.mapsQuery as string | null | undefined) ?? null,
          lat: opt(a.lat),
          lon: opt(a.lon),
          placeStatus: (a.placeStatus as string | null | undefined) ?? null,
          geoSource: (a.geoSource as string | null | undefined) ?? null,
          catalogue: a.catalogue === true,
          adopted: a.adopted === true,
          catalogueId: (a.catalogueId as string | null | undefined) ?? null,
          sourceKeys: Array.isArray(a.sourceKeys) ? (a.sourceKeys as string[]) : [],
          listed: a.listed !== false,
          hidden: a.hidden === true,
          edited: a.edited === true,
          contentHash: (a.contentHash as string | null | undefined) ?? null,
          cityCode: r.cityCode,
          cityName: r.cityName,
          votes: num(r.votes),
          plans: num(r.plans),
          comments: num(r.comments),
        };
      });
    },

    async upsertSources(sources: SourceRow[], now: string) {
      if (sources.length) await db.query(q("catalogue/sources-upsert"), { sources, now });
    },

    async create(tripId: string, rows: PlaceRow[]) {
      await inBatches(rows, (batch) => db.query(q("catalogue/create"), { tripId, rows: batch }));
    },

    async refresh(rows: PlaceRow[]) {
      await inBatches(rows, (batch) => db.query(q("catalogue/refresh"), { rows: batch }));
    },

    async adopt(rows: PlaceRow[]) {
      await inBatches(rows, (batch) => db.query(q("catalogue/adopt"), { rows: batch }));
    },

    async replaceSourceLinks(activityIds: string[], links: SourceLink[]) {
      await inBatches(activityIds, (ids) => db.query(q("catalogue/unlink-sources"), { ids }));
      await inBatches(links, (batch) => db.query(q("catalogue/link-sources"), { links: batch }));
    },

    async unlist(ids: string[], now: string) {
      await inBatches(ids, (batch) => db.query(q("catalogue/unlist"), { ids: batch, now }));
    },

    async remove(ids: string[]) {
      await inBatches(ids, (batch) => db.query(q("catalogue/remove"), { ids: batch }));
    },

    async recordLoad(record: LoadRecord) {
      await db.query(q("catalogue/load-record"), { ...record });
    },
  };
}

export type CatalogueRepository = ReturnType<typeof catalogueRepository>;
