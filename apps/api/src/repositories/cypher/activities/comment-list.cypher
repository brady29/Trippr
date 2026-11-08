MATCH (u:User)-[:WROTE]->(cm:Comment)-[:ON]->(:Activity {id: $activityId})
RETURN cm {.id, .text, .at} AS comment, u.id AS authorId, u.name AS authorName
ORDER BY cm.at
