MATCH (a:Activity {id: $activityId})
OPTIONAL MATCH (a)-[old:TAGGED]->(:Tag)
WITH a, collect(old) AS olds
FOREACH (x IN olds | DELETE x)
WITH a
UNWIND $tags AS tagName
MERGE (tg:Tag {name: tagName})
MERGE (a)-[:TAGGED]->(tg)
