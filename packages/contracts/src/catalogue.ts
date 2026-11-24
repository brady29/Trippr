import { z } from "zod";
import type { LibraryActivity } from "./dto";
import { cityCode } from "./schemas";

/**
 * The activity catalogue (docs/data-platform-spec.md, Feature 2): the seed bundle the data pipeline writes
 * (pipelines/src/trippr_data/bundle.py), the load job that reads it, the filtered and paged library, and the
 * Data page's read model. The bundle's files use snake_case, like the pipeline's Parquet.
 */

// --- the seed bundle: bundles/<date>/ -------------------------------------------------------------

export const BUNDLE_FORMAT = 1;
export const BUNDLE_FILES = {
  places: "places.jsonl.gz",
  sources: "sources.json",
  manifest: "manifest.json",
  parquet: "places.parquet",
  /** LLM enrichment, one line per enriched place, keyed by the place id. Optional. */
  enrichment: "enrichment.jsonl.gz",
  enrichmentParquet: "enrichment.parquet",
} as const;

/** What the enrichment stage may say about a place (pipelines/src/trippr_data/enrich/schema.py). */
export const BEST_TIMES = ["morning", "afternoon", "evening", "night", "any"] as const;
export const PRICE_LEVELS = ["free", "$", "$$", "$$$"] as const;
export const GOOD_FOR = ["rain", "families", "nightlife", "views"] as const;
export type BestTime = (typeof BEST_TIMES)[number];
export type PriceLevel = (typeof PRICE_LEVELS)[number];
export type GoodFor = (typeof GOOD_FOR)[number];

const nullable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable();
const utcTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "Expected a UTC timestamp like 2026-11-22T18:13:26Z");

/** One source record behind a curated place: kept all the way to the graph as provenance. */
export const bundlePlaceSourceSchema = z
  .object({
    source: z.string().min(1),
    source_id: z.string().min(1),
    licence: z.string().min(1),
    fetched_at: utcTimestamp,
    raw_ref: z.string(),
  })
  .strict();

export const bundlePlaceSchema = z
  .object({
    /** Stable id, "cat-" plus 16 hex characters; becomes the Activity id. */
    id: z.string().regex(/^cat-[0-9a-z]{1,32}$/),
    golden_id: z.string().min(1),
    city_code: cityCode,
    name: z.string().min(1).max(300),
    name_local: nullable(z.string()),
    name_en: nullable(z.string()),
    category: z.string().min(1),
    /** The app's colour tag for the category: sport, tech, nature, culture, food or other. */
    tag: z.enum(["sport", "tech", "nature", "culture", "food", "other"]),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    address: nullable(z.string()),
    website: nullable(z.string()),
    phone: nullable(z.string()),
    opening_hours: nullable(z.string()),
    wikidata_qid: nullable(z.string()),
    description: nullable(z.string()),
    score: z.number(),
    /** 1 = the city's best place. */
    rank: z.number().int().min(1),
    n_sources: z.number().int().min(1),
    confidence: nullable(z.number().min(0).max(1)),
    wikidata_sitelinks: nullable(z.number().int().min(0)),
    wikivoyage_listed: nullable(z.boolean()),
    sources: z.array(bundlePlaceSourceSchema).min(1),
  })
  .strict();
export type BundlePlace = z.infer<typeof bundlePlaceSchema>;
export type BundlePlaceSource = z.infer<typeof bundlePlaceSourceSchema>;

/** Where an enriched place's AI-written fields came from. `summary_ai` is what the "Summary written by AI" label hangs on. */
export const bundleEnrichmentProvenanceSchema = z
  .object({
    summary_ai: z.boolean(),
    model: z.string(),
    prompt_version: z.string(),
    enriched_at: utcTimestamp,
    batch_id: nullable(z.string()),
    input_sources: z.array(z.string()),
  })
  .strict();

/** One line of enrichment.jsonl.gz (pipelines/src/trippr_data/bundle_enrichment.py). `id` is the place's bundle id. */
export const bundleEnrichmentSchema = z
  .object({
    id: z.string().regex(/^cat-[0-9a-z]{1,32}$/),
    /** Taxonomy categories the model chose (museum, viewpoint, ...), at most four. */
    tags: z.array(z.string()).max(4),
    /** One line, at most 140 characters; empty when the model could not say anything the sources support. */
    summary: z.string().max(140),
    duration_min: nullable(z.number().int().min(5).max(1440)),
    best_time: nullable(z.enum(BEST_TIMES)),
    indoor: nullable(z.boolean()),
    price_level: nullable(z.enum(PRICE_LEVELS)),
    good_for: z.array(z.enum(GOOD_FOR)),
    /** A suggestion only: shown as a subtitle, never as the title, and only when is_generic_name is true. */
    display_name: nullable(z.string()),
    is_generic_name: z.boolean(),
    ai: z.boolean(),
    /** The sentence shown beside the summary, e.g. "Summary written by AI from Wikidata and Wikivoyage". */
    ai_label: nullable(z.string()),
    provenance: bundleEnrichmentProvenanceSchema,
  })
  .strict();
export type BundleEnrichment = z.infer<typeof bundleEnrichmentSchema>;

/** The manifest's `enrichment` section. */
export const bundleEnrichmentSummarySchema = z
  .object({
    places: z.number().int().min(0),
    with_summary: z.number().int().min(0),
    models: z.array(z.string()),
    prompt_versions: z.array(z.string()),
    enriched_at: nullable(utcTimestamp),
    /** The enriched/<date> folder the answers came from. */
    source_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
export type BundleEnrichmentSummary = z.infer<typeof bundleEnrichmentSummarySchema>;

/** A source registry entry as the Data page shows it (pipelines/sources.yaml plus counts and freshness). */
export const bundleSourceInfoSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    url: z.string(),
    licence: z.string(),
    licence_detail: nullable(z.string()),
    licence_urls: z.array(z.string()),
    attribution: z.string(),
    terms_checked_on: z.string(),
    allowed_uses: z.array(z.string()),
    enabled: z.boolean(),
    version: nullable(z.string()),
    fetched_at: nullable(z.string()),
    staged_rows: nullable(z.number().int()),
    places: z.number().int().min(0),
  })
  .strict();
export type BundleSourceInfo = z.infer<typeof bundleSourceInfoSchema>;

export const checkStatus = z.enum(["pass", "fail", "warn", "info"]);
export type CheckStatus = z.infer<typeof checkStatus>;

export const bundleCheckSchema = z
  .object({ name: z.string(), status: checkStatus, detail: z.string(), data: z.record(z.unknown()).default({}) })
  .strict();

export const bundleManifestSchema = z
  .object({
    format: z.literal(BUNDLE_FORMAT),
    bundle_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    created_at: utcTimestamp,
    pipeline_version: z.string(),
    /** The match stage's output: golden records. */
    input: z.literal("golden"),
    settings: z.record(z.unknown()),
    files: z.array(z.object({ name: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().min(0), rows: nullable(z.number().int()).optional() }).strict()),
    counts: z
      .object({
        places: z.number().int().min(0),
        cities: z.number().int().min(0),
        by_city: z.record(z.number().int()),
        by_category: z.record(z.number().int()),
        by_tag: z.record(z.number().int()),
        by_source: z.record(z.number().int()),
        with_licence: z.number().int().min(0),
        with_sources: z.number().int().min(0),
      })
      .strict(),
    checks: z.object({ passed: z.boolean(), results: z.array(bundleCheckSchema) }).strict(),
    /** Evaluation scores (entity matching, enrichment, search) as later pipeline stages add them. */
    evals: z.record(z.unknown()).default({}),
    /** Present when the bundle carries enrichment.jsonl.gz. */
    enrichment: nullable(bundleEnrichmentSummarySchema).optional(),
  })
  .strict();
export type BundleManifest = z.infer<typeof bundleManifestSchema>;

// --- the filtered, paged library ------------------------------------------------------------------

export const ACTIVITY_SCOPES = ["all", "mine", "catalogue"] as const;
export const ACTIVITY_SORTS = ["relevance", "score", "title"] as const;
export const PAGE_SIZE = 50;

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());

/**
 * GET /trips/:id/activities/page. Everything is optional.
 * scope: "mine" = the group's own ideas and catalogue places it voted or planned; "catalogue" = the loaded
 * places that are not the group's own; "all" = both.
 */
export const activityPageQuery = z.object({
  scope: z.enum(ACTIVITY_SCOPES).default("all"),
  city: optional(cityCode),
  /** The app's colour tag: sport, tech, nature, culture, food. */
  tag: optional(z.string().trim().toLowerCase().max(24)),
  /** A catalogue category from the taxonomy, e.g. "viewpoint". */
  category: optional(z.string().trim().max(40)),
  q: optional(z.string().trim().max(80)),
  /** A data source id, e.g. "overture". */
  source: optional(z.string().trim().max(40)),
  /** Catalogue places with at least this score. */
  minScore: optional(z.coerce.number().min(0).max(100)),
  /** Catalogue places ranked at most this high in their city (1 = best). */
  maxRank: optional(z.coerce.number().int().min(1).max(1000)),
  /** Only activities with a date or a date range. */
  fixedDates: z.preprocess((v) => v === "true" || v === "1" || v === true, z.boolean()).default(false),
  /** Include catalogue places the latest bundle no longer lists. */
  includeUnlisted: z.preprocess((v) => v === "true" || v === "1" || v === true, z.boolean()).default(false),
  /** Enrichment: places best at this time of day (places good at any time always match). */
  bestTime: optional(z.enum(BEST_TIMES)),
  /** Enrichment: true = indoor places, false = outdoor places. */
  indoor: z.preprocess((v) => (v === true || v === "true" || v === "1" ? true : v === false || v === "false" || v === "0" ? false : undefined), z.boolean().optional()),
  /** Enrichment: places that take at most this many minutes. */
  durationMax: optional(z.coerce.number().int().min(5).max(1440)),
  /** Enrichment: exactly this price level. */
  priceLevel: optional(z.enum(PRICE_LEVELS)),
  sort: z.enum(ACTIVITY_SORTS).default("relevance"),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(PAGE_SIZE),
});
/** What a client sends: every field is optional (the server fills in the defaults). */
export interface ActivityPageQuery {
  scope?: (typeof ACTIVITY_SCOPES)[number];
  city?: string;
  tag?: string;
  category?: string;
  q?: string;
  source?: string;
  minScore?: number;
  maxRank?: number;
  fixedDates?: boolean;
  includeUnlisted?: boolean;
  bestTime?: BestTime;
  indoor?: boolean;
  durationMax?: number;
  priceLevel?: PriceLevel;
  sort?: (typeof ACTIVITY_SORTS)[number];
  offset?: number;
  limit?: number;
}
export type ActivityPageParams = z.output<typeof activityPageQuery>;

export interface ActivityPage {
  items: LibraryActivity[];
  /** How many activities match the filters (not just this page). */
  total: number;
  offset: number;
  limit: number;
  /** The offset of the next page, or null on the last. */
  nextOffset: number | null;
}

/** What the filter menus offer, and the page's headline numbers. Not narrowed by the current filters. */
export interface ActivityFacets {
  cities: { code: string; name: string; count: number }[];
  tags: { name: string; count: number }[];
  categories: { name: string; count: number }[];
  sources: { id: string; name: string; count: number }[];
  /** Counts for the enrichment filters (places with an enrichment only). */
  enrichment: {
    enriched: number;
    bestTimes: { name: BestTime; count: number }[];
    priceLevels: { name: PriceLevel; count: number }[];
    indoor: number;
    outdoor: number;
    /** Places that take at most `max` minutes. */
    durations: { max: number; count: number }[];
  };
  totals: {
    /** The group's own ideas. */
    ideas: number;
    /** Catalogue places currently listed. */
    catalogue: number;
    /** Everything planned at some stop, own or catalogue. */
    planned: number;
    /** Everything with a pin. */
    onMap: number;
    cities: number;
  };
}

// --- the Data page --------------------------------------------------------------------------------

/** One source on the Data page: licence, attribution, counts, freshness. */
export interface DataSourceView {
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
  /** Rows after staging, before curation. */
  stagedRows: number | null;
  /** Activities in the graph that cite this source. */
  activities: number;
}

export interface DataCheckView {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DataLoadView {
  bundleDate: string;
  loadedAt: string;
  /** Entity-matched golden records. */
  input: "golden";
  pipelineVersion: string;
  counts: {
    places: number;
    cities: number;
    created: number;
    updated: number;
    adopted: number;
    unlisted: number;
    byTag: Record<string, number>;
    byCategory: Record<string, number>;
  };
  checks: { passed: boolean; results: DataCheckView[] };
  /** Evaluation scores as the pipeline recorded them in the manifest; `enrich` is an EnrichEvalView. */
  evals: Record<string, unknown>;
  /** What the bundle's enrichment holds; null when it had none. */
  enrichment: DataEnrichmentView | null;
}

export interface DataEnrichmentView {
  /** Places in the bundle with an enrichment, and how many of them have an AI summary. */
  places: number;
  withSummary: number;
  models: string[];
  promptVersions: string[];
  enrichedAt: string | null;
  sourceDate: string;
}

/** Enrichment scores from `eval-enrich` for the model (manifest evals.enrich; snake_case as the pipeline wrote them). */
export interface EnrichEvalView {
  model: string;
  judge_model: string | null;
  metrics: Record<string, number | null>;
  targets: Record<string, boolean>;
}

export interface DataSourcesResponse {
  sources: DataSourceView[];
  /** The last bundle the load job put in the graph; null before the first load. */
  latestLoad: DataLoadView | null;
  /** Activities in the graph by origin. `enriched` counts listed places with an AI enrichment. */
  totals: { catalogue: number; listed: number; unlisted: number; handWritten: number; enriched: number };
  /** How the catalogue is licensed and used, for the page's footer. */
  notes: string[];
}
