// Cities with activities in the trip's library, for the Activities page's city menu.
MATCH (a:Activity)-[:FOR]->(:Trip {id: $tripId}), (a)-[:IN]->(c:City)
WHERE coalesce(a.hidden, false) = false AND coalesce(a.listed, true) = true
RETURN c.code AS code, c.name AS name, count(a) AS n
ORDER BY c.name
