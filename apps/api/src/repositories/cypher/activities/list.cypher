// The trip's activity library, optionally narrowed to one city, one activity or a list of ids, with votes,
// your vote, tags, comment count and the routes that plan each one.
// Catalogue places (loaded from the data pipeline, thousands of them) only appear here when the group has
// engaged with them (a vote, a comment or a plan) or when asked for by id; the filtered, paged view of the
// whole catalogue is activities/page-ids.
MATCH (a:Activity)-[:FOR]->(t:Trip {id: $tripId}), (a)-[:IN]->(c:City)-[:IN]->(k:Country)
WHERE ($cityCode IS NULL OR c.code = $cityCode) AND ($activityId IS NULL OR a.id = $activityId)
  AND ($ids IS NULL OR a.id IN $ids) AND coalesce(a.hidden, false) = false
OPTIONAL MATCH (:User)-[v:VOTED]->(a)
WITH t, a, c, k, sum(coalesce(v.value, 0)) AS votes, count(v) AS voters
OPTIONAL MATCH (:User {id: $userId})-[mv:VOTED]->(a)
WITH t, a, c, k, votes, voters, coalesce(mv.value, 0) AS myVote
OPTIONAL MATCH (a)-[:TAGGED]->(tg:Tag)
WITH t, a, c, k, votes, voters, myVote, collect(tg.name) AS tags
OPTIONAL MATCH (cm:Comment)-[:ON]->(a)
WITH t, a, c, k, votes, voters, myVote, tags, count(cm) AS commentCount
OPTIONAL MATCH (t)-[:HAS_ROUTE]->(r:Route)-[:HAS_STOP]->(s:Stop)-[:PLANS]->(a)
WITH a, c, k, votes, voters, myVote, tags, commentCount, count(s) AS planCount,
     collect({routeId: r.id, routeName: r.name, stopId: s.id}) AS plannedIn
WHERE ($activityId IS NOT NULL OR $ids IS NOT NULL OR coalesce(a.catalogue, false) = false
       OR voters > 0 OR commentCount > 0 OR planCount > 0)
RETURN a {.id, .title, .when, .url, .costCad, .mapsQuery, .website, .ticketUrl, .reserveUrl, .mapsUrl, .lat, .lon, .address, .placeStatus,
          .catalogue, .category, .score, .rank, .listed, .nameLocal, .phone, .openingHours, .sources} AS activity,
       c.code AS cityCode, c.name AS cityName, k.iso AS countryIso,
       votes, myVote, tags, commentCount, plannedIn
ORDER BY votes DESC, a.title
