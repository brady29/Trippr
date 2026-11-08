// Gaps in Stop.order are harmless: order is only used for sorting.
MATCH (r:Route)-[:HAS_STOP]->(s:Stop {id: $stopId})
WHERE r.version = $version
SET r.version = r.version + 1
DETACH DELETE s
RETURN r.id AS routeId, r.version AS version
