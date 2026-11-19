import type { GraphClient } from "../db/graph";
import { activitiesRepository } from "./activities";
import { citiesRepository } from "./cities";
import { explorerRepository } from "./explorer";
import { graphRepository } from "./graph";
import { inboxRepository } from "./inbox";
import { routesRepository } from "./routes";
import { tripsRepository } from "./trips";
import { accessRepository, usersRepository } from "./users";

/** One repository per aggregate; nothing outside this folder writes Cypher. */
export function createRepositories(db: GraphClient) {
  return {
    users: usersRepository(db),
    access: accessRepository(db),
    trips: tripsRepository(db),
    routes: routesRepository(db),
    activities: activitiesRepository(db),
    cities: citiesRepository(db),
    explorer: explorerRepository(db),
    graph: graphRepository(db),
    inbox: inboxRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
export type { StoredLeg, StoredRoute, StoredStay, StoredStop } from "./routes";
