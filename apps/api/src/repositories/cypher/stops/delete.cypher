// Gaps in Stop.order are harmless: order is only used for sorting. The tickets into the stop go with it.
MATCH (r:Route)-[:HAS_STOP]->(s:Stop {id: $stopId})
WHERE r.version = $version
SET r.version = r.version + 1
WITH r, s
OPTIONAL MATCH (s)-[:ARRIVES_VIA]->(l:Leg)
WITH r, s, collect(l) AS legs
FOREACH (x IN legs | DETACH DELETE x)
DETACH DELETE s
RETURN r.id AS routeId, r.version AS version
