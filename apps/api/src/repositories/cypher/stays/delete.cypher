MATCH (r:Route)-[:HAS_STOP]->(s:Stop {id: $stopId})-[st:STAYS_AT]->(:Hotel {id: $hotelId})
WHERE r.version = $version
SET r.version = r.version + 1
DELETE st
RETURN r.id AS routeId, r.version AS version
