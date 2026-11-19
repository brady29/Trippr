// Re-point a leg's departure hub (runs right after the version-guarded patch).
MATCH (l:Leg {id: $legId})-[old:FROM]->(:Hub)
MATCH (h:Hub {hubId: $hubId})
DELETE old
CREATE (l)-[:FROM]->(h)
