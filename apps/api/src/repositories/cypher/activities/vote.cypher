MATCH (u:User {id: $userId}), (a:Activity {id: $activityId})
MERGE (u)-[v:VOTED]->(a)
SET v.value = $value, v.at = $now
