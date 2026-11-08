MATCH (r:Route {id: $routeId})
WHERE r.version = $version
MATCH (c:City {code: $cityCode})
SET r.version = r.version + 1
CREATE (r)-[:HAS_STOP]->(s:Stop {id: $stopId, order: $order, nights: $nights, arriveMode: $arriveMode})
CREATE (s)-[:AT]->(c)
WITH r
UNWIND $orders AS o
MATCH (r)-[:HAS_STOP]->(x:Stop {id: o.id})
SET x.order = o.order
RETURN DISTINCT r.version AS version
