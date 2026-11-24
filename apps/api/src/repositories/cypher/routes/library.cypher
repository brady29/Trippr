// Query 2: the shared activities for each stop, with votes. Activities hang off
// the City, so every route that stops in a city sees the same library.
// A catalogue place (hundreds per city) only shows here once the group has engaged with it:
// planned somewhere, voted on or commented on. Find the rest on the Activities page.
MATCH (t:Trip)-[:HAS_ROUTE]->(r:Route {id: $routeId})-[:HAS_STOP]->(s:Stop)-[:AT]->(c:City)<-[:IN]-(a:Activity)-[:FOR]->(t),
      (c)-[:IN]->(k:Country)
WHERE coalesce(a.hidden, false) = false
OPTIONAL MATCH (s)-[p:PLANS]->(a)
WITH s, c, k, a, p IS NOT NULL AS planned
OPTIONAL MATCH (:User)-[v:VOTED]->(a)
WITH s, c, k, a, planned, sum(coalesce(v.value, 0)) AS votes, count(v) AS voters
OPTIONAL MATCH (:Stop)-[ap:PLANS]->(a)
WITH s, c, k, a, planned, votes, voters, count(ap) AS plansAnywhere
OPTIONAL MATCH (cm:Comment)-[:ON]->(a)
WITH s, c, k, a, planned, votes, voters, plansAnywhere, count(cm) AS commentCount
WHERE coalesce(a.catalogue, false) = false OR planned OR voters > 0 OR plansAnywhere > 0 OR commentCount > 0
OPTIONAL MATCH (:User {id: $userId})-[mv:VOTED]->(a)
WITH s, c, k, a, planned, votes, commentCount, coalesce(mv.value, 0) AS myVote
OPTIONAL MATCH (a)-[:TAGGED]->(tg:Tag)
WITH s, c, k, a, planned, votes, myVote, commentCount, collect(tg.name) AS tags
RETURN s.id AS stopId, c.code AS cityCode, c.name AS cityName, k.iso AS countryIso,
       a {.id, .title, .when, .url, .costCad, .mapsQuery, .website, .ticketUrl, .reserveUrl, .mapsUrl, .lat, .lon, .address, .placeStatus,
          .catalogue, .category, .score, .rank, .listed, .nameLocal, .phone, .openingHours, .sources,
          .enrichedAt, .enrichModel, .summary, .summaryAi, .aiLabel, .enrichTags, .durationMin, .bestTime, .indoor,
          .priceLevel, .goodFor, .displayName, .genericName} AS activity,
       planned, votes, myVote, tags, commentCount
ORDER BY stopId, votes DESC
