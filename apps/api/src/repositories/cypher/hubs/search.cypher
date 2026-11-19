// Station and airport search for the leg form. A hub matches a city it serves or its home city.
MATCH (h:Hub)
OPTIONAL MATCH (h)-[:SERVES]->(c:City)
WITH h, collect(c.code) AS serves
WHERE ($kind IS NULL OR h.kind = $kind)
  AND ($city IS NULL OR h.cityCode = $city OR $city IN serves)
  AND ($q = ''
       OR toLower(h.name) CONTAINS toLower($q)
       OR toLower(h.hubId) CONTAINS toLower($q)
       OR toLower(coalesce(h.code, '')) = toLower($q)
       OR toLower(coalesce(h.cityName, '')) CONTAINS toLower($q))
RETURN h {.hubId, .kind, .code, .name, .nameLocal, .stationKind, .lat, .lon, .cityCode, .cityName} AS hub
ORDER BY h.name
LIMIT $limit
