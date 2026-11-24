// Activities whose title, local name, address, category or city name contain at least one of the (lower-case)
// $tokens, those matching the most tokens first, then the city's best places. The ranking in TypeScript scores
// them properly; this only has to find them. $cap bounds the rows.
MATCH (a:Activity)-[:FOR]->(:Trip {id: $tripId}), (a)-[:IN]->(c:City)
WHERE coalesce(a.hidden, false) = false
  AND (coalesce(a.catalogue, false) = false OR coalesce(a.listed, true) = true)
  AND ($cityCode IS NULL OR c.code = $cityCode)
  AND ($category IS NULL OR a.category = $category)
WITH a, c, size([t IN $tokens WHERE toLower(a.title) CONTAINS t OR toLower(coalesce(a.nameLocal, '')) CONTAINS t
                 OR toLower(coalesce(a.address, '')) CONTAINS t OR replace(toLower(coalesce(a.category, '')), '_', ' ') CONTAINS t
                 OR toLower(c.name) CONTAINS t]) AS hits
WHERE hits > 0
OPTIONAL MATCH (a)-[:TAGGED]->(tg:Tag)
WITH a, c, hits, collect(tg.name) AS tags
WHERE ($tag IS NULL OR $tag IN tags)
RETURN a.id AS id, a.title AS title, a.nameLocal AS nameLocal, a.address AS address, a.category AS category,
       a.lat AS lat, a.lon AS lon, a.rank AS rank, c.code AS cityCode, c.name AS cityName, tags
ORDER BY hits DESC, coalesce(a.rank, 1000000) ASC, a.id ASC
LIMIT $cap
