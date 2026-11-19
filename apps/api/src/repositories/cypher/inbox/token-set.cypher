// The secret part of the trip's inbox address. Replacing it retires the old address.
MATCH (t:Trip {id: $tripId})
SET t.inboxToken = $token
RETURN t.inboxToken AS token
