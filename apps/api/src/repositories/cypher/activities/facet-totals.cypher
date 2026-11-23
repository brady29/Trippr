// The Activities page's headline numbers.
MATCH (a:Activity)-[:FOR]->(:Trip {id: $tripId}), (a)-[:IN]->(c:City)
WHERE coalesce(a.hidden, false) = false AND coalesce(a.listed, true) = true
OPTIONAL MATCH (:Stop)-[p:PLANS]->(a)
WITH a, c, count(p) AS plans
RETURN sum(CASE WHEN coalesce(a.catalogue, false) = false THEN 1 ELSE 0 END) AS ideas,
       sum(CASE WHEN a.catalogue = true THEN 1 ELSE 0 END) AS catalogue,
       sum(CASE WHEN plans > 0 THEN 1 ELSE 0 END) AS planned,
       sum(CASE WHEN a.lat IS NOT NULL THEN 1 ELSE 0 END) AS onMap,
       count(DISTINCT c.code) AS cities
