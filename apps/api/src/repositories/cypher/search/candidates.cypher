// What the ranking needs about some activities of this trip (never the vector): title, local name, address,
// category, pin, rank and city, narrowed by the search's filters. Hidden activities and catalogue places the latest
// bundle no longer lists are left out.
MATCH (a:Activity)-[:FOR]->(:Trip {id: $tripId}), (a)-[:IN]->(c:City)
WHERE a.id IN $ids AND coalesce(a.hidden, false) = false
  AND (coalesce(a.catalogue, false) = false OR coalesce(a.listed, true) = true)
  AND ($cityCode IS NULL OR c.code = $cityCode)
  AND ($category IS NULL OR a.category = $category)
OPTIONAL MATCH (a)-[:TAGGED]->(tg:Tag)
WITH a, c, collect(tg.name) AS tags
WHERE ($tag IS NULL OR $tag IN tags)
RETURN a.id AS id, a.title AS title, a.nameLocal AS nameLocal, a.address AS address, a.category AS category,
       a.lat AS lat, a.lon AS lon, a.rank AS rank, c.code AS cityCode, c.name AS cityName, tags
