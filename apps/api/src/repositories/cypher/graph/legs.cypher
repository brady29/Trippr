// G4: legs and the hubs they join. Never booking references or seats (those are editor-only).
MATCH (t:Trip {id: $tripId})-[:HAS_ROUTE]->(r:Route)-[:HAS_STOP]->(s:Stop)-[v:ARRIVES_VIA]->(l:Leg)
WHERE $routeId IS NULL OR r.id = $routeId
MATCH (s)-[:AT]->(c:City)
MATCH (l)-[:FROM]->(a:Hub), (l)-[:TO]->(b:Hub)
RETURN r.id AS routeId, s.id AS stopId, c.code AS cityCode, v.seq AS seq,
       l {.id, .mode, .operator, .number, .departAt, .arriveAt, .durationMin, .priceCad, .status} AS leg,
       a {.hubId, .kind, .code, .name, .nameLocal, .stationKind, .lat, .lon, .cityCode, .cityName} AS fromHub,
       b {.hubId, .kind, .code, .name, .nameLocal, .stationKind, .lat, .lon, .cityCode, .cityName} AS toHub
ORDER BY routeId, stopId, seq
