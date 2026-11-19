MATCH (t:Trip {id: $tripId})
RETURN t.inboxToken AS token
