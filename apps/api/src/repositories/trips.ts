import type { Member, Role, TripListItem, TripRef } from "@trippr/contracts";
import type { GraphClient } from "../db/graph";
import { newId, nowIso } from "../ids";
import { cypher } from "./queries";
import { num } from "./util";

export function tripsRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const read = { readOnly: true };
  return {
    async listForUser(userId: string): Promise<TripListItem[]> {
      const rows = await db.query<{ trip: TripRef; role: Role; routeCount: number }>(
        q("trips/list-mine"),
        { userId },
        read,
      );
      return rows.map((r) => ({ ...r.trip, role: r.role, routeCount: num(r.routeCount) }));
    },

    async create(userId: string, input: { name: string; startDate: string; homeCity?: string }) {
      const id = newId("trip");
      await db.query(q("trips/create"), {
        userId,
        id,
        routeId: newId("rt"),
        name: input.name,
        startDate: input.startDate,
        homeCity: input.homeCity ?? null,
        now: nowIso(),
      });
      return id;
    },

    async get(tripId: string): Promise<TripRef | null> {
      const [row] = await db.query<{ trip: TripRef }>(q("trips/get"), { tripId }, read);
      return row?.trip ?? null;
    },

    async patch(tripId: string, input: { name?: string; startDate?: string; homeCity?: string }) {
      await db.query(q("trips/patch"), {
        tripId,
        name: input.name ?? null,
        startDate: input.startDate ?? null,
        homeCity: input.homeCity ?? null,
      });
    },

    members: (tripId: string) => db.query<Member>(q("trips/members"), { tripId }, read),

    async routeIds(tripId: string): Promise<string[]> {
      const rows = await db.query<{ id: string }>(q("trips/route-ids"), { tripId }, read);
      return rows.map((r) => r.id);
    },

    async setMemberRole(tripId: string, userId: string, role: Role) {
      await db.query(q("trips/set-member-role"), { tripId, userId, role, now: nowIso() });
    },

    async createInvite(tripId: string, userId: string, role: Role, token: string, expiresAt: string) {
      await db.query(q("invites/create"), { tripId, userId, role, token, expiresAt, now: nowIso() });
    },

    async getInvite(token: string) {
      const [row] = await db.query<{ role: Role; expiresAt: string; trip: TripRef }>(
        q("invites/get"),
        { token },
        read,
      );
      return row ?? null;
    },

    async deleteInvite(token: string) {
      await db.query(q("invites/delete"), { token });
    },
  };
}
