MATCH (t:Trip {id: $tripId})
OPTIONAL MATCH (:User {id: $userId})-[m:MEMBER_OF]->(t)
RETURN t.id AS tripId, m.role AS role
