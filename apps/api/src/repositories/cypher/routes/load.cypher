// Query 1: load a route (the editor's main read). Dates are computed in rules.ts.
MATCH (r:Route {id: $routeId})-[:HAS_STOP]->(s:Stop)-[:AT]->(c:City)-[:IN]->(k:Country)
OPTIONAL MATCH (s)-[p:PLANS]->(a:Activity)
WITH s, c, k, collect(a {.id, .title, .when, .costCad, day: p.day}) AS planned
ORDER BY s.order
RETURN collect({
  stop: s {.*},
  city: c {.code, .name, .lat, .lon},
  country: k {.iso, .name, .visaRule, .color},
  planned: planned
}) AS stops
