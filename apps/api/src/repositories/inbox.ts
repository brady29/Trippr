import type { InboxItem, InboxKind, InboxSource, InboxStatus, InboxSuggestion, Role } from "@trippr/contracts";
import type { GraphClient } from "../db/graph";
import { newId, nowIso } from "../ids";
import { cypher } from "./queries";
import { str } from "./util";

type Row = Record<string, unknown>;

function parseSuggestion(json: unknown): InboxSuggestion | null {
  if (typeof json !== "string" || !json) return null;
  try {
    return JSON.parse(json) as InboxSuggestion;
  } catch {
    return null;
  }
}

const toItem = (r: Row): InboxItem => ({
  id: String(r.id),
  tripId: String(r.tripId),
  messageId: String(r.messageId),
  source: (r.source as InboxSource) ?? "paste",
  from: str(r.sender),
  fromName: str(r.senderName),
  subject: str(r.subject),
  receivedAt: String(r.receivedAt),
  kind: (r.kind as InboxKind) ?? "unknown",
  status: (r.status as InboxStatus) ?? "pending",
  summary: String(r.summary ?? ""),
  suggestion: parseSuggestion(r.suggestionJson),
  stopId: str(r.stopId),
  stopLabel: str(r.stopLabel),
  note: str(r.note),
  appliedBy: str(r.appliedBy),
  appliedAt: str(r.appliedAt),
});

export interface NewInboxItem {
  tripId: string;
  messageId: string;
  source: InboxSource;
  from: string | null;
  fromName: string | null;
  subject: string | null;
  kind: InboxKind;
  status: InboxStatus;
  summary: string;
  suggestion: InboxSuggestion | null;
  stopId: string | null;
  stopLabel: string | null;
  note: string | null;
}

export interface InboxUpdate {
  status: InboxStatus;
  note: string | null;
  stopId: string | null;
  stopLabel: string | null;
  suggestion: InboxSuggestion | null;
  appliedBy?: string | null;
  appliedAt?: string | null;
}

/** Inbox items hang off their trip; the trip also holds the secret part of its inbox address. */
export function inboxRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const read = { readOnly: true };
  return {
    async create(item: NewInboxItem): Promise<string> {
      const id = newId("ib");
      await db.query(q("inbox/create"), {
        ...item,
        id,
        suggestionJson: item.suggestion ? JSON.stringify(item.suggestion) : null,
        receivedAt: nowIso(),
      });
      return id;
    },
    async list(tripId: string, limit = 100): Promise<InboxItem[]> {
      return (await db.query<Row>(q("inbox/list"), { tripId, limit }, read)).map(toItem);
    },
    async get(id: string): Promise<InboxItem | null> {
      const [row] = await db.query<Row>(q("inbox/get"), { id }, read);
      return row ? toItem(row) : null;
    },
    async update(id: string, patch: InboxUpdate): Promise<void> {
      await db.query(q("inbox/update"), {
        id,
        status: patch.status,
        note: patch.note,
        stopId: patch.stopId,
        stopLabel: patch.stopLabel,
        suggestionJson: patch.suggestion ? JSON.stringify(patch.suggestion) : null,
        appliedBy: patch.appliedBy ?? null,
        appliedAt: patch.appliedAt ?? null,
      });
    },
    async getToken(tripId: string): Promise<string | null> {
      const [row] = await db.query<{ token: string | null }>(q("inbox/token-get"), { tripId }, read);
      return row?.token ?? null;
    },
    async setToken(tripId: string, token: string): Promise<string> {
      await db.query(q("inbox/token-set"), { tripId, token });
      return token;
    },
    async tripByToken(token: string): Promise<string | null> {
      const [row] = await db.query<{ tripId: string }>(q("inbox/trip-by-token"), { token }, read);
      return row?.tripId ?? null;
    },
    async ensureHub(hub: {
      hubId: string;
      kind: "station" | "airport";
      code: string | null;
      name: string;
      cityCode: string | null;
      cityName: string | null;
      lat: number | null;
      lon: number | null;
    }): Promise<{ hubId: string; kind: "station" | "airport" }> {
      const [row] = await db.query<{ hubId: string; kind: "station" | "airport" }>(q("inbox/hub-ensure"), hub);
      return row!;
    },
    async memberByEmail(tripId: string, email: string): Promise<{ id: string; name: string | null; role: Role | null } | null> {
      const [row] = await db.query<{ id: string; name: string | null; role: Role | null }>(q("inbox/member-by-email"), { tripId, email }, read);
      return row ?? null;
    },
  };
}
