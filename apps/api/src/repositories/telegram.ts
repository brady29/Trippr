import type { Role, TelegramChatLink } from "@trippr/contracts";
import type { GraphClient } from "../db/graph";
import { nowIso } from "../ids";
import { cypher } from "./queries";

/** A chat (or code) resolved to its trip and the member behind it; role is null once they've left the trip. */
export interface TelegramLink {
  tripId: string;
  tripName: string;
  userId: string | null;
  userName: string | null;
  role: Role | null;
}

export function telegramRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const read = { readOnly: true };
  return {
    async code(tripId: string, userId: string): Promise<string | null> {
      const [row] = await db.query<{ code: string }>(q("telegram/code-get"), { tripId, userId }, read);
      return row?.code ?? null;
    },
    async setCode(tripId: string, userId: string, code: string): Promise<string | null> {
      const [row] = await db.query<{ code: string }>(q("telegram/code-set"), { tripId, userId, code, now: nowIso() });
      return row?.code ?? null;
    },
    async byCode(code: string): Promise<TelegramLink | null> {
      const [row] = await db.query<TelegramLink>(q("telegram/by-code"), { code }, read);
      return row ?? null;
    },
    async link(chatId: string, tripId: string, userId: string, title: string | null, kind: "private" | "group") {
      await db.query(q("telegram/link"), { chatId, tripId, userId, title, kind, now: nowIso() });
    },
    async chat(chatId: string): Promise<TelegramLink | null> {
      const [row] = await db.query<TelegramLink>(q("telegram/chat"), { chatId }, read);
      return row ?? null;
    },
    async list(tripId: string): Promise<TelegramChatLink[]> {
      const rows = await db.query<{ chatId: string; title: string | null; kind: string | null; linkedAt: string; linkedBy: string | null }>(
        q("telegram/list"),
        { tripId },
        read,
      );
      return rows.map((r) => ({ chatId: String(r.chatId), title: r.title, kind: r.kind === "private" ? "private" : "group", linkedAt: r.linkedAt, linkedBy: r.linkedBy }));
    },
    /** Returns false when the chat wasn't linked (to that trip). */
    async unlink(chatId: string, tripId: string | null): Promise<boolean> {
      const rows = await db.query<{ ok: number }>(q("telegram/unlink"), { chatId, tripId });
      return rows.length > 0;
    },
    /** True the first time an update id is seen. */
    async fresh(updateId: number): Promise<boolean> {
      const [row] = await db.query<{ fresh: boolean }>(q("telegram/seen"), { updateId });
      return Boolean(row?.fresh);
    },
  };
}
