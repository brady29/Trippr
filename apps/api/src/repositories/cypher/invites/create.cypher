MATCH (t:Trip {id: $tripId})
CREATE (i:Invite {token: $token, role: $role, tripId: $tripId, createdAt: $now, expiresAt: $expiresAt, createdBy: $userId})
CREATE (i)-[:TO]->(t)
RETURN i.token AS token
