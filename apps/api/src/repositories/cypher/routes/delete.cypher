MATCH (r:Route {id: $routeId})
OPTIONAL MATCH (r)-[:HAS_STOP]->(s:Stop)
WITH r, collect(s) AS stops
FOREACH (x IN stops | DETACH DELETE x)
DETACH DELETE r
