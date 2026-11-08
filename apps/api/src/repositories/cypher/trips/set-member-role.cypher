MATCH (u:User {id: $userId}), (t:Trip {id: $tripId})
MERGE (u)-[m:MEMBER_OF]->(t)
ON CREATE SET m.at = $now
SET m.role = $role
RETURN m.role AS role
