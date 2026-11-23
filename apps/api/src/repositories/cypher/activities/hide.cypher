// Deleting a catalogue place hides it instead: the load job would add it back otherwise. Its comments, votes
// and plans go, like any deleted activity. Returns nothing for hand-written activities.
MATCH (a:Activity {id: $activityId})
WHERE a.catalogue = true
SET a.hidden = true, a.listed = false
WITH a
OPTIONAL MATCH (cm:Comment)-[:ON]->(a)
WITH a, collect(cm) AS comments
FOREACH (x IN comments | DETACH DELETE x)
WITH a
OPTIONAL MATCH (:User)-[v:VOTED]->(a)
WITH a, collect(v) AS votes
FOREACH (x IN votes | DELETE x)
WITH a
OPTIONAL MATCH (:Stop)-[p:PLANS]->(a)
WITH a, collect(p) AS plans
FOREACH (x IN plans | DELETE x)
RETURN a.id AS id
