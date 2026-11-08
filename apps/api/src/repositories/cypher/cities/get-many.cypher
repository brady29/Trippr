MATCH (c:City)-[:IN]->(k:Country)
WHERE c.code IN $codes
RETURN c {.code, .name, .lat, .lon} AS city, k.iso AS countryIso, k.name AS countryName
