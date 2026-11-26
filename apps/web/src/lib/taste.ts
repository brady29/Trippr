import type { LibraryActivity } from "@trippr/contracts";
import { ACTIVITY_TAGS, primaryTag, type ActivityTag } from "./graph-palette";

/**
 * Group taste from vote counts only: how many said yes and no to each idea,
 * never who. One member's own votes are theirs to see.
 */
export interface ConsensusPoint {
  id: string;
  title: string;
  cityName: string;
  tag: ActivityTag;
  yes: number;
  no: number;
  /** -1 (everyone said no) to 1 (everyone said yes). */
  liking: number;
  /** 0 (an even split) to 1 (everyone agrees). */
  agreement: number;
}

export function consensusPoints(items: readonly LibraryActivity[]): ConsensusPoint[] {
  return items
    .map((a) => {
      const yes = a.ups ?? Math.max(0, a.votes);
      const no = a.downs ?? Math.max(0, -a.votes);
      const n = yes + no;
      return { a, yes, no, n };
    })
    .filter((p) => p.n > 0)
    .map(({ a, yes, no, n }) => ({
      id: a.id,
      title: a.title,
      cityName: a.cityName,
      tag: primaryTag(a.tags, a.category ?? undefined),
      yes,
      no,
      liking: (yes - no) / n,
      agreement: 1 - (2 * Math.min(yes, no)) / n,
    }));
}

/** The ideas everyone loves (most yes, no dissent first) and the ones that split the group. */
export function consensusHighlights(points: readonly ConsensusPoint[]) {
  const loved = points.filter((p) => p.liking > 0.5 && p.agreement >= 0.75).sort((a, b) => b.yes - a.yes || b.agreement - a.agreement);
  const split = points.filter((p) => p.yes + p.no >= 2 && p.agreement < 0.5).sort((a, b) => b.yes + b.no - (a.yes + a.no));
  return { loved, split };
}

export interface TasteAxis {
  tag: ActivityTag;
  /** Share of your yes votes that went to this kind of idea (0 to 1). */
  you: number;
  /** Share of all the group's yes votes (0 to 1). */
  group: number;
}

/** What you say yes to, next to what the group says yes to, by kind of idea. */
export function tasteProfile(items: readonly LibraryActivity[]): TasteAxis[] {
  const mine = new Map<ActivityTag, number>();
  const all = new Map<ActivityTag, number>();
  let myTotal = 0;
  let groupTotal = 0;
  for (const a of items) {
    const tag = primaryTag(a.tags, a.category ?? undefined);
    if (a.myVote === 1) {
      mine.set(tag, (mine.get(tag) ?? 0) + 1);
      myTotal++;
    }
    const yes = a.ups ?? Math.max(0, a.votes);
    if (yes > 0) {
      all.set(tag, (all.get(tag) ?? 0) + yes);
      groupTotal += yes;
    }
  }
  return ACTIVITY_TAGS.map((tag) => ({
    tag,
    you: myTotal ? (mine.get(tag) ?? 0) / myTotal : 0,
    group: groupTotal ? (all.get(tag) ?? 0) / groupTotal : 0,
  }));
}
