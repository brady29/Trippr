MATCH (t:Trip {id: $tripId})
CREATE (t)-[:HAS_ROUTE]->(r:Route {id: $id, name: $name, tags: $tags, isCurrent: false, version: 0, createdAt: $now})
RETURN r.id AS id
