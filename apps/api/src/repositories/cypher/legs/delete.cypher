MATCH (r:Route)-[:HAS_STOP]->(s:Stop)-[:ARRIVES_VIA]->(l:Leg {id: $legId})
WHERE r.version = $version
SET r.version = r.version + 1, s.arriveMode = coalesce($arriveMode, s.arriveMode)
DETACH DELETE l
RETURN r.id AS routeId, r.version AS version
