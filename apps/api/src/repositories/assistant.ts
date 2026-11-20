import type { AssistantTurn } from "@trippr/contracts";
import type { GraphClient } from "../db/graph";
import { nowIso } from "../ids";
import { cypher } from "./queries";

/**
 * (:User)-[:ASKED]->(:AssistantThread {id, tripId, messagesJson, updatedAt, day, dayCount}).
 * One thread per member per trip, private to that member. `day`/`dayCount`
 * count today's questions for the daily limit; clearing a thread keeps them.
 */
export function assistantRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const threadId = (tripId: string, userId: string) => `${tripId}:${userId}`;

  return {
    async turns(userId: string, tripId: string): Promise<AssistantTurn[]> {
      const [row] = await db.query<{ thread: { messagesJson?: string | null } | null }>(
        q("assistant/thread-get"),
        { id: threadId(tripId, userId) },
        { readOnly: true },
      );
      const json = row?.thread?.messagesJson;
      if (!json) return [];
      try {
        const parsed = JSON.parse(json) as unknown;
        return Array.isArray(parsed) ? (parsed as AssistantTurn[]) : [];
      } catch {
        return [];
      }
    },

    async usedToday(userId: string, day: string): Promise<number> {
      const [row] = await db.query<{ used: number | null }>(q("assistant/usage-today"), { userId, day }, { readOnly: true });
      return Number(row?.used ?? 0);
    },

    /** Counts one question (creating the thread if needed); returns today's count on this trip. */
    async count(userId: string, tripId: string, day: string): Promise<number> {
      const [row] = await db.query<{ count: number }>(q("assistant/count"), {
        id: threadId(tripId, userId),
        userId,
        tripId,
        day,
        now: nowIso(),
      });
      return Number(row?.count ?? 0);
    },

    async save(userId: string, tripId: string, turns: AssistantTurn[]) {
      await db.query(q("assistant/thread-save"), { id: threadId(tripId, userId), messagesJson: JSON.stringify(turns), now: nowIso() });
    },
  };
}

export type AssistantRepository = ReturnType<typeof assistantRepository>;
