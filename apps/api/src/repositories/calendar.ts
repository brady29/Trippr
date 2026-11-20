import type { LegPrivate, Role } from "@trippr/contracts";
import type { GraphClient } from "../db/graph";
import { nowIso } from "../ids";
import { cypher } from "./queries";

export interface StoredFeed {
  includePrivate: boolean;
  createdAt: string;
}

export interface FeedOwner {
  userId: string;
  tripId: string;
  includePrivate: boolean;
  /** The owner's current role on the trip; null once they are no longer a member. */
  role: Role | null;
}

/**
 * Calendar feeds: (:User)-[:HAS_FEED]->(:CalendarFeed {tokenHash, tripId, includePrivate, createdAt}).
 * One per member per trip. The token itself is never stored, only its hash.
 */
export function calendarRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const read = { readOnly: true };
  return {
    /** Create the member's feed, replacing (and so killing) any earlier link. */
    async replace(userId: string, tripId: string, tokenHash: string, includePrivate: boolean): Promise<StoredFeed> {
      await db.query(q("calendar/feed-delete"), { userId, tripId });
      const [row] = await db.query<StoredFeed>(q("calendar/feed-create"), { userId, tripId, tokenHash, includePrivate, now: nowIso() });
      return { includePrivate: row?.includePrivate === true, createdAt: String(row?.createdAt ?? nowIso()) };
    },
    async get(userId: string, tripId: string): Promise<StoredFeed | null> {
      const [row] = await db.query<StoredFeed>(q("calendar/feed-get"), { userId, tripId }, read);
      return row ? { includePrivate: row.includePrivate === true, createdAt: String(row.createdAt) } : null;
    },
    async remove(userId: string, tripId: string): Promise<void> {
      await db.query(q("calendar/feed-delete"), { userId, tripId });
    },
    async byHash(tokenHash: string): Promise<FeedOwner | null> {
      const [row] = await db.query<FeedOwner>(q("calendar/feed-by-hash"), { tokenHash }, read);
      return row ? { userId: String(row.userId), tripId: String(row.tripId), includePrivate: row.includePrivate === true, role: row.role ?? null } : null;
    },
    async currentRouteId(tripId: string): Promise<string | null> {
      const [row] = await db.query<{ id: string }>(q("calendar/current-route"), { tripId }, read);
      return row?.id ?? null;
    },
    /** Booking references and seats for a route's legs (editors and the owner only). */
    async legRefs(routeId: string): Promise<LegPrivate[]> {
      return db.query<LegPrivate>(q("bookings/leg-refs"), { routeId }, read);
    },
  };
}
