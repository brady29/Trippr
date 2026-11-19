// Places that used to be modelled as cities (Pudong airport, Longyang Road) are hubs now.
// Remove the old city versions, and their LINK edges, unless a stop still uses them.
MATCH (c:City)
WHERE c.code IN $codes
OPTIONAL MATCH (s:Stop)-[:AT]->(c)
WITH c, count(s) AS uses
WHERE uses = 0
DETACH DELETE c
