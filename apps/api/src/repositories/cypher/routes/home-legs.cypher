// How the group gets home after the last stop: ticket segments hung off the route itself, in order.
// Includes booking fields; the API strips them before anything leaves for a viewer.
MATCH (:Route {id: $routeId})-[v:RETURNS_VIA]->(l:Leg)
MATCH (l)-[:FROM]->(a:Hub), (l)-[:TO]->(b:Hub)
RETURN v.seq AS seq,
       l {.id, .mode, .operator, .number, .departAt, .arriveAt, .durationMin, .priceCad, .status, .bookingRef, .seat, .source, .asOf, .priceAsOf, .priceSource} AS leg,
       a {.hubId, .kind, .code, .name, .nameLocal, .stationKind, .lat, .lon, .cityCode, .cityName} AS fromHub,
       b {.hubId, .kind, .code, .name, .nameLocal, .stationKind, .lat, .lon, .cityCode, .cityName} AS toHub
ORDER BY seq
