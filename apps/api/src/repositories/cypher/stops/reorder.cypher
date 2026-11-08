MATCH (r:Route {id: $routeId})
WHERE r.version = $version
SET r.version = r.version + 1
WITH r
UNWIND $orders AS o
MATCH (r)-[:HAS_STOP]->(x:Stop {id: o.id})
SET x.order = o.order
RETURN DISTINCT r.version AS version
