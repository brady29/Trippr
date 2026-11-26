// Who may touch a leg: one into a stop, or a ticket home hung off the route (stopId is null then).
MATCH (t:Trip)-[:HAS_ROUTE]->(r:Route)-[:HAS_STOP]->(s:Stop)-[:ARRIVES_VIA]->(:Leg {id: $legId})
OPTIONAL MATCH (:User {id: $userId})-[m:MEMBER_OF]->(t)
RETURN t.id AS tripId, r.id AS routeId, s.id AS stopId, m.role AS role
UNION
MATCH (t:Trip)-[:HAS_ROUTE]->(r:Route)-[:RETURNS_VIA]->(:Leg {id: $legId})
OPTIONAL MATCH (:User {id: $userId})-[m:MEMBER_OF]->(t)
RETURN t.id AS tripId, r.id AS routeId, null AS stopId, m.role AS role
