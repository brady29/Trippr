import type { Comment, LibraryActivity } from "@trippr/contracts";
import type { When } from "@trippr/rules";
import type { GraphClient } from "../db/graph";
import { newId, nowIso } from "../ids";
import { cypher } from "./queries";
import { num, optNum, parseJson, toJson } from "./util";

type Row = {
  activity: { id: string; title: string; when: unknown; url: string | null; costCad: unknown };
  cityCode: string;
  cityName: string;
  votes: number;
  myVote: number;
  tags: string[];
  commentCount: number;
  plannedIn: { routeId: string | null; routeName: string | null; stopId: string | null }[];
};

export function activitiesRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const read = { readOnly: true };

  async function list(
    tripId: string,
    userId: string,
    filter: { cityCode?: string; activityId?: string } = {},
  ): Promise<LibraryActivity[]> {
    const rows = await db.query<Row>(
      q("activities/list"),
      { tripId, userId, cityCode: filter.cityCode ?? null, activityId: filter.activityId ?? null },
      read,
    );
    return rows.map((r) => ({
      id: r.activity.id,
      title: r.activity.title,
      when: parseJson<When>(r.activity.when),
      url: r.activity.url ?? null,
      costCad: optNum(r.activity.costCad),
      tags: [...(r.tags ?? [])].sort(),
      cityCode: r.cityCode,
      cityName: r.cityName,
      votes: num(r.votes),
      myVote: Math.sign(num(r.myVote)) as -1 | 0 | 1,
      commentCount: num(r.commentCount),
      plannedIn: (r.plannedIn ?? [])
        .filter((p) => p && p.routeId != null)
        .map((p) => ({ routeId: String(p.routeId), routeName: String(p.routeName), stopId: String(p.stopId) })),
    }));
  }

  return {
    list,

    async get(tripId: string, userId: string, activityId: string) {
      return (await list(tripId, userId, { activityId }))[0] ?? null;
    },

    async create(
      userId: string,
      input: {
        tripId: string;
        cityCode: string;
        title: string;
        tags: string[];
        when?: When | null;
        url?: string | null;
        costCad?: number | null;
      },
    ) {
      const id = newId("act");
      await db.query(q("activities/create"), {
        id,
        userId,
        tripId: input.tripId,
        cityCode: input.cityCode,
        title: input.title,
        tags: input.tags,
        when: toJson(input.when),
        url: input.url ?? null,
        costCad: input.costCad ?? null,
        now: nowIso(),
      });
      return id;
    },

    async patch(
      activityId: string,
      input: { title?: string; tags?: string[]; when?: When | null; url?: string | null; costCad?: number | null },
    ) {
      await db.query(q("activities/patch"), {
        activityId,
        title: input.title ?? null,
        setUrl: input.url !== undefined,
        url: input.url ?? null,
        setWhen: input.when !== undefined,
        when: toJson(input.when),
        setCost: input.costCad !== undefined,
        costCad: input.costCad ?? null,
      });
      if (input.tags) await db.query(q("activities/set-tags"), { activityId, tags: input.tags });
    },

    async delete(activityId: string) {
      await db.query(q("activities/delete"), { activityId });
    },

    async vote(userId: string, activityId: string, value: -1 | 0 | 1) {
      if (value === 0) await db.query(q("activities/unvote"), { userId, activityId });
      else await db.query(q("activities/vote"), { userId, activityId, value, now: nowIso() });
    },

    async addComment(userId: string, activityId: string, text: string) {
      const id = newId("cm");
      await db.query(q("activities/comment-create"), { id, userId, activityId, text, now: nowIso() });
      return id;
    },

    async comments(activityId: string): Promise<Comment[]> {
      const rows = await db.query<{
        comment: { id: string; text: string; at: string };
        authorId: string;
        authorName: string;
      }>(q("activities/comment-list"), { activityId }, read);
      return rows.map((r) => ({ ...r.comment, author: { id: r.authorId, name: r.authorName } }));
    },
  };
}
