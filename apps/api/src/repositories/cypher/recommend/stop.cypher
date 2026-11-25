// The stop a suggestions request is about: the trip it belongs to and its city.
MATCH (t:Trip)-[:HAS_ROUTE]->(r:Route)-[:HAS_STOP]->(s:Stop {id: $stopId})-[:AT]->(c:City)
RETURN t.id AS tripId, r.id AS routeId, c.code AS cityCode, c.name AS cityName
