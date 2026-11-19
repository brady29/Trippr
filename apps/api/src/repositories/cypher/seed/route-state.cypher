// Has this sample route ever been added? A Migration marker remembers routes
// that were seeded and later deleted, so they are never re-created.
OPTIONAL MATCH (r:Route {id: $id})
WITH count(r) AS routes
OPTIONAL MATCH (m:Migration {id: $marker})
RETURN routes > 0 AS present, count(m) > 0 AS marked
