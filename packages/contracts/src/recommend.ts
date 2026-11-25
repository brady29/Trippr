import { z } from "zod";
import { BEST_TIMES } from "./catalogue";
import type { LibraryActivity } from "./dto";

/**
 * "Suggested for this stop" (docs/data-platform-spec.md, Feature 4, Recommendations): the request and response of
 * GET /stops/:id/suggestions. The suggestions come from the group's own votes, plans and comments and the stored
 * place vectors; nothing on the request path calls an embedder or a language model.
 */

export const SUGGESTIONS_LIMIT_MAX = 20;
export const SUGGESTIONS_LIMIT_DEFAULT = 6;

const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

/** GET /stops/:id/suggestions?limit=&bestTime=&indoor= (all optional). */
export const suggestionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(SUGGESTIONS_LIMIT_MAX).default(SUGGESTIONS_LIMIT_DEFAULT),
  /** Enrichment: only places best at this time of day (places good at any time always match). */
  bestTime: optional(z.enum(BEST_TIMES)),
  /** Enrichment: true = indoor places, false = outdoor places; places the enrichment could not tell are left out. */
  indoor: z.preprocess((v) => (v === true || v === "true" || v === "1" ? true : v === false || v === "false" || v === "0" ? false : undefined), z.boolean().optional()),
});
export type SuggestionsParams = z.output<typeof suggestionsQuery>;

/**
 * What the suggestions rest on:
 *  - group_taste: the group's liked places in this city (votes up, plans, comments) and their vectors;
 *  - tag_preferences: nothing liked in this city yet, so the city's own ranking leaning toward the tags the group liked elsewhere;
 *  - catalogue_rank: no signals at all (or no vectors are loaded), so the city's ranking alone.
 */
export type SuggestionBasis = "group_taste" | "tag_preferences" | "catalogue_rank";

/** A coarse word for how close two places are in meaning, never a number (the databases' scores differ a little). */
export type Closeness = "very close" | "close" | "loosely related";

/** The liked place a suggestion is similar to, with what the group did with it. */
export interface SuggestionAnchor {
  activityId: string;
  title: string;
  /** Members who voted it up. */
  voters: number;
  planned: boolean;
  /** The caller is one of the voters. */
  votedByYou: boolean;
}

export interface Suggestion {
  activity: LibraryActivity;
  /**
   * One sentence built from the inputs above (a liked place, a category and rank, a tag the group likes): written by
   * this program's rules, not by a language model.
   */
  reason: string;
  /** Why it is in the list in one word each: "similar" (to a liked place), "tag" (a tag the group likes), "rank" (the city's ranking). */
  because: "similar" | "tag" | "rank";
  anchor: SuggestionAnchor | null;
  closeness: Closeness | null;
}

export type SuggestionNoticeCode =
  /** Nothing liked in this city yet. */
  | "cold_start"
  /** No place vectors are loaded (or they could not be read), so similarity was not used. */
  | "no_vectors"
  /** The group liked places here, but none of them has a place vector, so similarity could not be used. */
  | "no_taste"
  /** Everything in the city's catalogue is already planned, voted on or filtered out. */
  | "none_left";

export interface SuggestionNotice {
  code: SuggestionNoticeCode;
  message: string;
}

export interface SuggestionsResponse {
  stopId: string;
  cityCode: string;
  cityName: string;
  basis: SuggestionBasis;
  notice: SuggestionNotice | null;
  /** Counts only: places the group liked or disliked in this city, and members who voted. */
  signals: { liked: number; disliked: number; members: number };
  /** The tags the group likes most (colour tags like "culture"), when they shaped the list. */
  likedTags: string[];
  suggestions: Suggestion[];
}

/** What a client sends. */
export interface SuggestionsRequest {
  limit?: number;
  bestTime?: string;
  indoor?: boolean;
}
