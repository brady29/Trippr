MATCH (t:Trip)-[:HAS_ROUTE]->(r:Route {id: $routeId})
OPTIONAL MATCH (:User {id: $userId})-[m:MEMBER_OF]->(t)
RETURN t.id AS tripId, r.id AS routeId, m.role AS role
