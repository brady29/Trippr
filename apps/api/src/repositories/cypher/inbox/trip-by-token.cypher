MATCH (t:Trip {inboxToken: $token})
RETURN t.id AS tripId
