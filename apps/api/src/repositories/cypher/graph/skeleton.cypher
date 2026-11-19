// G1: route skeleton (routes, stops, cities, countries), optionally one route or one city.
MATCH (t:Trip {id: $tripId})-[:HAS_ROUTE]->(r:Route)
WHERE $routeId IS NULL OR r.id = $routeId
MATCH (r)-[:HAS_STOP]->(s:Stop)-[:AT]->(c:City)-[:IN]->(k:Country)
WHERE $city IS NULL OR c.code = $city
RETURN r.id AS routeId, r.name AS routeName,
       s {.id, .order, .nights, .arriveMode} AS stop,
       c {.code, .name, .lat, .lon} AS city,
       k {.iso, .name, .color} AS country
ORDER BY routeId, s.order
