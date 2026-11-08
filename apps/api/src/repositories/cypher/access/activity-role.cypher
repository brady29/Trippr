MATCH (:Activity {id: $activityId})-[:FOR]->(t:Trip)
OPTIONAL MATCH (:User {id: $userId})-[m:MEMBER_OF]->(t)
RETURN t.id AS tripId, m.role AS role
