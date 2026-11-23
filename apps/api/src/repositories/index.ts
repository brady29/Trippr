import type { GraphClient } from "../db/graph";
import { activitiesRepository } from "./activities";
import { calendarRepository } from "./calendar";
import { catalogueRepository } from "./catalogue";
import { citiesRepository } from "./cities";
import { dataRepository } from "./data";
import { explorerRepository } from "./explorer";
import { flightsRepository } from "./flights";
import { graphRepository } from "./graph";
import { inboxRepository } from "./inbox";
import { placesRepository } from "./places";
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
    places: placesRepository(db),
    calendar: calendarRepository(db),
    flights: flightsRepository(db),
    catalogue: catalogueRepository(db),
    data: dataRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
export type { StoredLeg, StoredRoute, StoredStay, StoredStop } from "./routes";
