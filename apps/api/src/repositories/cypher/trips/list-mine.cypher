MATCH (:User {id: $userId})-[m:MEMBER_OF]->(t:Trip)
OPTIONAL MATCH (t)-[:HAS_ROUTE]->(r:Route)
WITH t, m, count(r) AS routeCount
RETURN t {.id, .name, .startDate, .homeCity} AS trip, m.role AS role, routeCount
ORDER BY t.startDate
