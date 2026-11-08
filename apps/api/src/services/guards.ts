import { hasRole, type Role } from "@trippr/contracts";
import type { AuthUser } from "../auth";
import { forbidden, notFound } from "../errors";
import type { Repositories } from "../repositories";

type Found = { tripId: string; routeId?: string; role: Role | null } | null;

function check<T extends NonNullable<Found>>(row: T | null, minimum: Role, what: string): T & { role: Role } {
  // Non-members get a 404 so ids cannot be probed for existence.
  if (!row || !row.role) throw notFound(what);
  if (!hasRole(row.role, minimum)) throw forbidden(`This needs the ${minimum} role on the trip`);
  return row as T & { role: Role };
}

/**
 * Every request is mapped to the trip that owns the resource, and the
 * caller's MEMBER_OF role on that trip is checked against the endpoint's
 * minimum role.
 */
export function createGuards(repos: Repositories) {
  return {
    async trip(user: AuthUser, tripId: string, minimum: Role) {
      return check(await repos.access.tripRole(tripId, user.id), minimum, "Trip");
    },
    async route(user: AuthUser, routeId: string, minimum: Role) {
      return check(await repos.access.routeRole(routeId, user.id), minimum, "Route") as {
        tripId: string;
        routeId: string;
        role: Role;
      };
    },
    async stop(user: AuthUser, stopId: string, minimum: Role) {
      return check(await repos.access.stopRole(stopId, user.id), minimum, "Stop") as {
        tripId: string;
        routeId: string;
        role: Role;
      };
    },
    async activity(user: AuthUser, activityId: string, minimum: Role) {
      return check(await repos.access.activityRole(activityId, user.id), minimum, "Activity");
    },
  };
}

export type Guards = ReturnType<typeof createGuards>;
