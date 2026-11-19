// The trip's hotel library, optionally for one city or one hotel, with votes and the stops that use it.
MATCH (h:Hotel)-[:FOR]->(t:Trip {id: $tripId}), (h)-[:IN]->(a:Area)-[:IN]->(c:City)
WHERE ($city IS NULL OR c.code = $city) AND ($hotelId IS NULL OR h.id = $hotelId)
OPTIONAL MATCH (:User)-[v:VOTED]->(h)
WITH t, h, a, c, sum(coalesce(v.value, 0)) AS votes
OPTIONAL MATCH (:User {id: $userId})-[mv:VOTED]->(h)
WITH t, h, a, c, votes, coalesce(mv.value, 0) AS myVote
OPTIONAL MATCH (t)-[:HAS_ROUTE]->(r:Route)-[:HAS_STOP]->(s:Stop)-[st:STAYS_AT]->(h)
WITH h, a, c, votes, myVote, collect({stopId: s.id, routeId: r.id, routeName: r.name, status: st.status}) AS stays
RETURN h {.id, .name, .url, .lat, .lon, .priceCadPerNight, .priceBasis, .sleeps, .rating, .notes} AS hotel,
       a.id AS areaId, a.name AS areaName, c.code AS cityCode, c.name AS cityName, votes, myVote, stays
ORDER BY votes DESC, h.name
