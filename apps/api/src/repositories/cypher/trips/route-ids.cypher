MATCH (:Trip {id: $tripId})-[:HAS_ROUTE]->(r:Route)
RETURN r.id AS id
ORDER BY r.createdAt
