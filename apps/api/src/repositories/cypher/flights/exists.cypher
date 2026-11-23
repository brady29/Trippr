// Has this route already been snapshotted for this day? (the daily job is idempotent per route and day)
MATCH (p:FlightPrice {id: $id})
RETURN p.id AS id
