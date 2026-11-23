// Data sources cited by the trip's activities, for the source menu.
MATCH (a:Activity)-[:FOR]->(:Trip {id: $tripId}), (a)-[:FROM_SOURCE]->(d:DataSource)
WHERE coalesce(a.hidden, false) = false AND coalesce(a.listed, true) = true
RETURN d.id AS id, d.name AS name, count(DISTINCT a) AS n
ORDER BY d.name
