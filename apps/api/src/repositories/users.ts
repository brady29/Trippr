import type { Me, Role } from "@trippr/contracts";
import type { GraphClient } from "../db/graph";
import { nowIso } from "../ids";
import { cypher } from "./queries";

type UserRow = { id: string; name: string; email: string | null };
type RoleRow = { tripId: string; routeId?: string; role: Role | null };

export function usersRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  return {
    async upsert(user: { id: string; name?: string | null; email?: string | null }): Promise<Me> {
      const [row] = await db.query<UserRow>(q("users/upsert"), {
        id: user.id,
        name: user.name ?? null,
        email: user.email ?? null,
        now: nowIso(),
      });
      return row!;
    },
    async update(id: string, patch: { name?: string; email?: string }): Promise<Me | null> {
      const [row] = await db.query<UserRow>(q("users/update"), {
        id,
        name: patch.name ?? null,
        email: patch.email ?? null,
      });
      return row ?? null;
    },
  };
}

/** Resolves the trip that owns a resource and the caller's MEMBER_OF role on it. */
export function accessRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const one = async (name: string, params: Record<string, unknown>) =>
    (await db.query<RoleRow>(q(name), params, { readOnly: true }))[0] ?? null;
  return {
    tripRole: (tripId: string, userId: string) => one("access/trip-role", { tripId, userId }),
    routeRole: (routeId: string, userId: string) => one("access/route-role", { routeId, userId }),
    stopRole: (stopId: string, userId: string) => one("access/stop-role", { stopId, userId }),
    activityRole: (activityId: string, userId: string) => one("access/activity-role", { activityId, userId }),
  };
}
