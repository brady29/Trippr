// A member's private calendar link for one trip. Only the SHA-256 hash of the token is stored.
MATCH (u:User {id: $userId})
CREATE (u)-[:HAS_FEED]->(f:CalendarFeed {tokenHash: $tokenHash, tripId: $tripId, includePrivate: $includePrivate, createdAt: $now})
RETURN f.includePrivate AS includePrivate, f.createdAt AS createdAt
