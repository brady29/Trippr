// Stops in routes waiting for their first idea legs (sample routes added later).
MATCH (r:Route {needsLegs: true})-[:HAS_STOP]->(s:Stop)-[:AT]->(c:City)
OPTIONAL MATCH (s)-[v:ARRIVES_VIA]->(:Leg)
WITH r, s, c, count(v) AS legs
RETURN r.id AS routeId, s.id AS stopId, s.order AS stopOrder, s.arriveMode AS arriveMode, c.code AS cityCode, legs
ORDER BY routeId, stopOrder
