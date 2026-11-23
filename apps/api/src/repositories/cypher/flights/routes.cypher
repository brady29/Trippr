// Every trip's current route (or its first, when none is marked), for the daily flight snapshot.
MATCH (t:Trip)-[:HAS_ROUTE]->(r:Route)
RETURN t.id AS tripId, r.id AS routeId, r.isCurrent AS isCurrent, r.createdAt AS createdAt
ORDER BY tripId, createdAt
