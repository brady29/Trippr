MATCH (t:Trip)-[:HAS_ROUTE]->(r:Route {id: $routeId})
OPTIONAL MATCH (r)-[:DERIVED_FROM]->(p:Route)
RETURN r {.id, .name, .tags, .isCurrent, .version, .createdAt} AS route,
       t {.id, .name, .startDate, .homeCity, .travellers, .latestReturn} AS trip,
       p {.id, .name} AS derivedFrom
