// Several stops' nights at once (a trade between two stops). A route-structure write.
MATCH (r:Route {id: $routeId})
WHERE r.version = $version
SET r.version = r.version + 1
WITH r
UNWIND $nights AS n
MATCH (r)-[:HAS_STOP]->(s:Stop {id: n.stopId})
SET s.nights = n.nights
RETURN DISTINCT r.version AS version
