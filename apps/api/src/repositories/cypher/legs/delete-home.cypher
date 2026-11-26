MATCH (r:Route)-[:RETURNS_VIA]->(l:Leg {id: $legId})
WHERE r.version = $version
SET r.version = r.version + 1
DETACH DELETE l
RETURN r.id AS routeId, r.version AS version
