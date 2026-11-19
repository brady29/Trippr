// The trip's areas worth staying in, optionally for one city or one area, with votes and hotel counts.
MATCH (a:Area)-[:FOR]->(:Trip {id: $tripId}), (a)-[:IN]->(c:City)
WHERE ($city IS NULL OR c.code = $city) AND ($areaId IS NULL OR a.id = $areaId)
OPTIONAL MATCH (:User)-[v:VOTED]->(a)
WITH a, c, sum(coalesce(v.value, 0)) AS votes
OPTIONAL MATCH (:User {id: $userId})-[mv:VOTED]->(a)
WITH a, c, votes, coalesce(mv.value, 0) AS myVote
OPTIONAL MATCH (h:Hotel)-[:IN]->(a)
WITH a, c, votes, myVote, count(h) AS hotelCount
RETURN a {.id, .name, .lat, .lon, .vibes, .note} AS area, c.code AS cityCode, c.name AS cityName,
       votes, myVote, hotelCount
ORDER BY votes DESC, a.name
