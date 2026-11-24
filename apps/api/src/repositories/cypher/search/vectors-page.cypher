// One page of vectors for the exact (in-memory) search, with just the metadata its filters use. Paged by id
// (keyset) so each page is cheap; the vector is returned here and nowhere else.
MATCH (a:Activity)-[:IN]->(c:City)
WHERE a.embedding IS NOT NULL AND a.id > $after
WITH a, c
ORDER BY a.id
LIMIT $limit
OPTIONAL MATCH (a)-[:TAGGED]->(tg:Tag)
WITH a, c, collect(tg.name) AS tags
RETURN a.id AS id, c.code AS cityCode, a.category AS category, a.lat AS lat, a.lon AS lon, tags, a.embedding AS vector
ORDER BY id
