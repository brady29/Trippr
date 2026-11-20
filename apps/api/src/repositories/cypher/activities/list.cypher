// The trip's activity library, optionally narrowed to one city or one activity,
// with votes, your vote, tags, comment count and the routes that plan each one.
MATCH (a:Activity)-[:FOR]->(t:Trip {id: $tripId}), (a)-[:IN]->(c:City)-[:IN]->(k:Country)
WHERE ($cityCode IS NULL OR c.code = $cityCode) AND ($activityId IS NULL OR a.id = $activityId)
OPTIONAL MATCH (:User)-[v:VOTED]->(a)
WITH t, a, c, k, sum(coalesce(v.value, 0)) AS votes
OPTIONAL MATCH (:User {id: $userId})-[mv:VOTED]->(a)
WITH t, a, c, k, votes, coalesce(mv.value, 0) AS myVote
OPTIONAL MATCH (a)-[:TAGGED]->(tg:Tag)
WITH t, a, c, k, votes, myVote, collect(tg.name) AS tags
OPTIONAL MATCH (cm:Comment)-[:ON]->(a)
WITH t, a, c, k, votes, myVote, tags, count(cm) AS commentCount
OPTIONAL MATCH (t)-[:HAS_ROUTE]->(r:Route)-[:HAS_STOP]->(s:Stop)-[:PLANS]->(a)
WITH a, c, k, votes, myVote, tags, commentCount, collect({routeId: r.id, routeName: r.name, stopId: s.id}) AS plannedIn
RETURN a {.id, .title, .when, .url, .costCad, .mapsQuery, .website, .ticketUrl, .reserveUrl, .mapsUrl, .lat, .lon, .address, .placeStatus} AS activity,
       c.code AS cityCode, c.name AS cityName, k.iso AS countryIso,
       votes, myVote, tags, commentCount, plannedIn
ORDER BY votes DESC, a.title
