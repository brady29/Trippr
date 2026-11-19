MATCH (u:User {id: $userId}), (a:Area {id: $areaId})
MERGE (u)-[v:VOTED]->(a)
SET v.value = $value, v.at = $now
