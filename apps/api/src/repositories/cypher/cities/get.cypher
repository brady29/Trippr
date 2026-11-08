MATCH (c:City {code: $code})-[:IN]->(k:Country)
RETURN c {.code, .name, .lat, .lon} AS city, k.iso AS countryIso, k.name AS countryName
