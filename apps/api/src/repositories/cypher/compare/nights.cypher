// Query 4: nights per country (feeds the compare view and the checks panel).
MATCH (:Route {id: $routeId})-[:HAS_STOP]->(s:Stop)-[:AT]->(:City)-[:IN]->(k:Country)
RETURN k.name AS country, k.iso AS iso, sum(s.nights) AS nights
ORDER BY nights DESC
