MATCH (u:User {id: $userId}), (h:Hotel {id: $hotelId})
MERGE (u)-[v:VOTED]->(h)
SET v.value = $value, v.at = $now
