// One owner invite per trip, only while the trip has no owner yet.
// Re-running the seed keeps the same link until it expires.
MATCH (t:Trip {id: $tripId})
OPTIONAL MATCH (:User)-[m:MEMBER_OF {role: 'owner'}]->(t)
WITH t, count(m) AS owners
WHERE owners = 0
MERGE (i:Invite {role: 'owner', tripId: $tripId})-[:TO]->(t)
ON CREATE SET i.token = $token, i.createdAt = $now, i.expiresAt = $expiresAt
WITH i, i.expiresAt < $now AS stale
SET i.token = CASE WHEN stale THEN $token ELSE i.token END,
    i.expiresAt = CASE WHEN stale THEN $expiresAt ELSE i.expiresAt END
RETURN i.token AS token, i.expiresAt AS expiresAt
