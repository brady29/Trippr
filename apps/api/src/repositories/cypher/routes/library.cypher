// Query 2: the shared activities for each stop, with votes. Activities hang off
// the City, so every route that stops in a city sees the same library.
MATCH (t:Trip)-[:HAS_ROUTE]->(r:Route {id: $routeId})-[:HAS_STOP]->(s:Stop)-[:AT]->(c:City)<-[:IN]-(a:Activity)-[:FOR]->(t)
OPTIONAL MATCH (s)-[p:PLANS]->(a)
WITH s, c, a, p IS NOT NULL AS planned
OPTIONAL MATCH (:User)-[v:VOTED]->(a)
WITH s, c, a, planned, sum(coalesce(v.value, 0)) AS votes
OPTIONAL MATCH (:User {id: $userId})-[mv:VOTED]->(a)
WITH s, c, a, planned, votes, coalesce(mv.value, 0) AS myVote
OPTIONAL MATCH (a)-[:TAGGED]->(tg:Tag)
WITH s, c, a, planned, votes, myVote, collect(tg.name) AS tags
OPTIONAL MATCH (cm:Comment)-[:ON]->(a)
RETURN s.id AS stopId, c.code AS cityCode, c.name AS cityName,
       a {.id, .title, .when, .url, .costCad, .mapsQuery} AS activity,
       planned, votes, myVote, tags, count(cm) AS commentCount
ORDER BY stopId, votes DESC
