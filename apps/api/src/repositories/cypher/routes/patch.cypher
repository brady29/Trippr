// Optimistic locking: the write only happens when the caller's version matches.
MATCH (t:Trip)-[:HAS_ROUTE]->(r:Route {id: $routeId})
WHERE r.version = $version
SET r.name = coalesce($name, r.name), r.tags = coalesce($tags, r.tags), r.version = r.version + 1
WITH t, r
MATCH (t)-[:HAS_ROUTE]->(o:Route)
WITH r, collect(o) AS routes
FOREACH (o IN CASE WHEN $makeCurrent THEN routes ELSE [] END | SET o.isCurrent = (o.id = r.id))
RETURN r.version AS version
