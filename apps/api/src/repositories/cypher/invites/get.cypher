MATCH (i:Invite {token: $token})-[:TO]->(t:Trip)
RETURN i.role AS role, i.expiresAt AS expiresAt, t {.id, .name, .startDate, .homeCity} AS trip
