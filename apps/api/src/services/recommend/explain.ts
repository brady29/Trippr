import type { Closeness, SuggestionBasis } from "@trippr/contracts";
import type { CityActivity } from "../../repositories/recommend";
import type { Signal, Tuning } from "./core";

/**
 * The sentence that says why a place is suggested. It is assembled by rules from facts the program holds (a liked place's
 * title and who voted for it, the place's category and rank, a tag the group likes) and never from a language model; it
 * claims nothing it cannot back. The similarity is only used to decide whether a liked place may be named, and to pick a
 * coarse word ("close"); no number is ever shown.
 */

export interface Reason {
  text: string;
  because: "similar" | "tag" | "rank";
  anchor: Signal | null;
  closeness: Closeness | null;
  tag: string | null;
}

export interface ExplainInput {
  basis: SuggestionBasis;
  row: CityActivity;
  cityName: string;
  /** The place's standing among its own category in the city (1 = best), when known. */
  categoryRank: number | null;
  /** The liked place nearest in meaning and the cosine to it; null without vectors. */
  anchor: Signal | null;
  anchorSim: number | null;
  /** The tags the group likes most, best first. */
  likedTags: string[];
  /** The member asking. */
  userId: string;
  tuning: Pick<Tuning, "anchorClose" | "anchorVeryClose">;
}

export const humanizeCategory = (category: string) => category.replace(/_/g, " ");

export function closenessWord(similarity: number, tuning: Pick<Tuning, "anchorClose" | "anchorVeryClose">): Closeness {
  return similarity >= tuning.anchorVeryClose ? "very close" : similarity >= tuning.anchorClose ? "close" : "loosely related";
}

/** What the group did with a liked place, in the words of the sentence: "3 of you voted for", "you voted for", "your group planned". */
export function whatTheGroupDid(anchor: Signal, userId: string): string {
  const voted =
    anchor.voters >= 2
      ? `${anchor.voters} of you voted for`
      : anchor.voters === 1
        ? anchor.votedBy[0] === userId
          ? "you voted for"
          : "one of you voted for"
        : "";
  if (voted) return anchor.planned ? `${voted} and planned` : voted;
  if (anchor.planned) return "your group planned";
  return "your group commented on";
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A fact about the place's standing: "Top-ranked museum in Osaka", "#2 museum in Osaka", "Ranked #14 in Osaka". */
export function rankPhrase(row: Pick<CityActivity, "rank" | "category">, cityName: string, categoryRank: number | null): string {
  const kind = row.category ? humanizeCategory(row.category) : null;
  if (kind && categoryRank === 1) return `Top-ranked ${kind} in ${cityName}`;
  if (kind && categoryRank != null && categoryRank <= 3) return `#${categoryRank} ${kind} in ${cityName}`;
  if (row.rank != null) return `Ranked #${row.rank} in ${cityName}`;
  return kind ? capital(`${kind} in ${cityName}`) : `In the ${cityName} catalogue`;
}

export function explain(i: ExplainInput): Reason {
  if (i.anchor && i.anchorSim != null && i.anchorSim >= i.tuning.anchorClose) {
    return {
      text: `Similar to ${i.anchor.title}, which ${whatTheGroupDid(i.anchor, i.userId)}`,
      because: "similar",
      anchor: i.anchor,
      closeness: closenessWord(i.anchorSim, i.tuning),
      tag: null,
    };
  }
  const tag = i.likedTags.find((t) => i.row.tags.includes(t)) ?? null;
  const fact = rankPhrase(i.row, i.cityName, i.categoryRank);
  if (tag) return { text: `${fact}; your group likes ${tag}`, because: "tag", anchor: null, closeness: null, tag };
  return { text: fact, because: "rank", anchor: null, closeness: null, tag: null };
}
