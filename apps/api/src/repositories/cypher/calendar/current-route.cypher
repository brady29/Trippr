// The trip's current route, or its oldest route when none is marked current.
MATCH (:Trip {id: $tripId})-[:HAS_ROUTE]->(r:Route)
RETURN r.id AS id
ORDER BY CASE WHEN r.isCurrent = true THEN 0 ELSE 1 END, r.createdAt
LIMIT 1
