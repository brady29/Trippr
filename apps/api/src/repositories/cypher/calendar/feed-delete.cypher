// Turn a member's feed for a trip off (also the first half of making a new link).
MATCH (:User {id: $userId})-[:HAS_FEED]->(f:CalendarFeed {tripId: $tripId})
DETACH DELETE f
