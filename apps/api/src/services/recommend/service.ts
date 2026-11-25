import type { Suggestion, SuggestionNotice, SuggestionsParams, SuggestionsResponse } from "@trippr/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { Repositories } from "../../repositories";
import type { Search } from "../search/service";
import { suggestForCity, type Suggested } from "./core";

export interface RecommendDeps {
  repos: Repositories;
  /** Where the stored place vectors come from (the search service's in-memory matrix). */
  search: Pick<Search, "vectorMatrix">;
  log: Pick<FastifyBaseLogger, "warn">;
}

export type Recommend = ReturnType<typeof createRecommend>;

/** What the panel says when it is not working from the group's taste. Plain words, and true. */
export function noticeFor(
  result: Pick<Suggested, "basis" | "likedTags" | "liked" | "candidates">,
  context: { cityName: string; vectors: boolean },
): SuggestionNotice | null {
  const { cityName } = context;
  if (result.candidates === 0) {
    return {
      code: "none_left",
      message: `Nothing left to suggest in ${cityName}: every catalogue place there is planned, voted on or filtered out.`,
    };
  }
  if (result.basis === "group_taste") return null;
  if (!context.vectors) {
    return {
      code: "no_vectors",
      message: "Place vectors are not loaded on this server, so similarity was not used. These follow the city's ranking and the tags your group likes.",
    };
  }
  if (result.liked > 0) {
    return {
      code: "no_taste",
      message: `The places your group liked in ${cityName} have no place vectors yet, so similarity was not used. These follow the city's ranking and the tags your group likes.`,
    };
  }
  const elsewhere = result.likedTags.length ? ` leaning toward what your group liked elsewhere (${result.likedTags.join(", ")})` : "";
  return {
    code: "cold_start",
    message: `Nobody has voted on, planned or commented on places in ${cityName} yet, so these are the city's top-ranked places${elsewhere}. Vote on a few and they will follow your taste.`,
  };
}

/**
 * Suggestions for one stop from the group's own signals and the stored place vectors. Free and fast by design: the vectors
 * are already in memory (shared with search), nothing is embedded and no model is called, so it needs no allowance, works
 * for the demo account and does not depend on the hosted embedder.
 */
export function createRecommend(deps: RecommendDeps) {
  const { repos, search, log } = deps;

  async function run(userId: string, stopId: string, params: SuggestionsParams): Promise<SuggestionsResponse | null> {
    const stop = await repos.recommend.stop(stopId);
    if (!stop) return null;
    const [rows, otherTags, matrix] = await Promise.all([
      repos.recommend.cityActivities(stop.tripId, stop.cityCode),
      repos.recommend.tagPreferences(stop.tripId, stop.cityCode),
      search.vectorMatrix(),
    ]);
    const result = suggestForCity({
      cityName: stop.cityName,
      rows,
      otherTags,
      vectorOf: (id) => (matrix ? matrix.unitVector(id) : null),
      userId,
      limit: params.limit,
      bestTime: params.bestTime,
      indoor: params.indoor,
    });

    const cards = result.picks.length ? await repos.activities.list(stop.tripId, userId, { ids: result.picks.map((p) => p.row.id) }) : [];
    const byId = new Map(cards.map((a) => [a.id, a]));
    const suggestions: Suggestion[] = [];
    for (const pick of result.picks) {
      const activity = byId.get(pick.row.id);
      if (!activity) {
        log.warn({ activityId: pick.row.id }, "a suggested place could not be read");
        continue;
      }
      const anchor = pick.reason.anchor;
      suggestions.push({
        activity,
        reason: pick.reason.text,
        because: pick.reason.because,
        anchor: anchor
          ? { activityId: anchor.id, title: anchor.title, voters: anchor.voters, planned: anchor.planned, votedByYou: anchor.votedBy.includes(userId) }
          : null,
        closeness: pick.reason.closeness,
      });
    }
    return {
      stopId,
      cityCode: stop.cityCode,
      cityName: stop.cityName,
      basis: result.basis,
      notice: noticeFor(result, { cityName: stop.cityName, vectors: matrix !== null }),
      signals: { liked: result.liked, disliked: result.disliked, members: result.members },
      likedTags: result.likedTags,
      suggestions,
    };
  }

  return { run };
}
