// How each stop of a route is reached: ticket segments between hubs, in order.
// Includes booking fields; the API strips them before anything leaves for a viewer.
MATCH (:Route {id: $routeId})-[:HAS_STOP]->(s:Stop)-[v:ARRIVES_VIA]->(l:Leg)
MATCH (l)-[:FROM]->(a:Hub), (l)-[:TO]->(b:Hub)
RETURN s.id AS stopId, v.seq AS seq,
       l {.id, .mode, .operator, .number, .departAt, .arriveAt, .durationMin, .priceCad, .status, .bookingRef, .seat, .freeCancelUntil, .source, .asOf, .priceAsOf, .priceSource} AS leg,
       a {.hubId, .kind, .code, .name, .nameLocal, .stationKind, .lat, .lon, .cityCode, .cityName} AS fromHub,
       b {.hubId, .kind, .code, .name, .nameLocal, .stationKind, .lat, .lon, .cityCode, .cityName} AS toHub
ORDER BY stopId, seq
