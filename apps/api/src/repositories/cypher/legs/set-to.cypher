// Re-point a leg's arrival hub (runs right after the version-guarded patch).
MATCH (l:Leg {id: $legId})-[old:TO]->(:Hub)
MATCH (h:Hub {hubId: $hubId})
DELETE old
CREATE (l)-[:TO]->(h)
