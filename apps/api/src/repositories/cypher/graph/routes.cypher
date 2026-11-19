// G0: the trip and its routes (for meta, the route filter and camera presets).
MATCH (t:Trip {id: $tripId})
OPTIONAL MATCH (t)-[:HAS_ROUTE]->(r:Route)
RETURN t {.id, .name, .startDate} AS trip, collect(r {.id, .name, .isCurrent, .version, .createdAt}) AS routes
