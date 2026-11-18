// Deleting an activity removes it from every route that planned it, with its comments and votes.
MATCH (a:Activity {id: $activityId})
OPTIONAL MATCH (cm:Comment)-[:ON]->(a)
WITH a, collect(cm) AS comments
FOREACH (x IN comments | DETACH DELETE x)
DETACH DELETE a
