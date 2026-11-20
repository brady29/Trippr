MATCH (:User {id: $userId})-[:HAS_FEED]->(f:CalendarFeed {tripId: $tripId})
RETURN f.includePrivate AS includePrivate, f.createdAt AS createdAt
ORDER BY f.createdAt DESC
LIMIT 1
