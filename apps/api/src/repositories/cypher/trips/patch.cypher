MATCH (t:Trip {id: $tripId})
SET t.name = coalesce($name, t.name),
    t.startDate = coalesce($startDate, t.startDate),
    t.homeCity = coalesce($homeCity, t.homeCity)
RETURN t.id AS id
