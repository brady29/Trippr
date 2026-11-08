// Trip properties are only set on creation so re-seeding never clobbers edits.
MERGE (t:Trip {id: $id})
ON CREATE SET t.name = $name, t.startDate = $startDate, t.homeCity = $homeCity, t.createdAt = $now
RETURN t.createdAt = $now AS created
