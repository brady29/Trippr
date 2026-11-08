MATCH (u:User {id: $userId}), (a:Activity {id: $activityId})
CREATE (cm:Comment {id: $id, text: $text, at: $now})
CREATE (u)-[:WROTE]->(cm)
CREATE (cm)-[:ON]->(a)
RETURN cm.id AS id
