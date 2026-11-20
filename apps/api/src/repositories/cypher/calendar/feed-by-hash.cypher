// Resolve a feed token (by its hash) to its member and trip, with the member's current role.
// A member who has left or been removed comes back with a null role.
MATCH (u:User)-[:HAS_FEED]->(f:CalendarFeed {tokenHash: $tokenHash})
OPTIONAL MATCH (u)-[m:MEMBER_OF]->(t:Trip)
WHERE t.id = f.tripId
RETURN u.id AS userId, f.tripId AS tripId, f.includePrivate AS includePrivate, m.role AS role
LIMIT 1
