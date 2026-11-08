MATCH (c:City)-[:IN]->(k:Country)
WHERE coalesce(c.kind, 'city') <> 'station'
  AND ($q = '' OR toLower(c.name) CONTAINS toLower($q) OR c.code = toUpper($q) OR toLower(k.name) CONTAINS toLower($q))
RETURN c {.code, .name, .lat, .lon} AS city, k.iso AS countryIso, k.name AS countryName
ORDER BY c.name
LIMIT $limit
