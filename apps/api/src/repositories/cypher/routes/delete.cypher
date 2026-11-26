// A route goes with its stops, the tickets into them and the tickets home.
MATCH (r:Route {id: $routeId})
OPTIONAL MATCH (r)-[:HAS_STOP]->(s:Stop)
OPTIONAL MATCH (s)-[:ARRIVES_VIA]->(l:Leg)
OPTIONAL MATCH (r)-[:RETURNS_VIA]->(h:Leg)
WITH r, collect(DISTINCT s) AS stops, collect(DISTINCT l) AS legs, collect(DISTINCT h) AS home
FOREACH (x IN legs | DETACH DELETE x)
FOREACH (x IN home | DETACH DELETE x)
FOREACH (x IN stops | DETACH DELETE x)
DETACH DELETE r
