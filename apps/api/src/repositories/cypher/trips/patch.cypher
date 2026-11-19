MATCH (t:Trip {id: $tripId})
SET t.name = coalesce($name, t.name),
    t.startDate = coalesce($startDate, t.startDate),
    t.homeCity = coalesce($homeCity, t.homeCity),
    t.travellers = coalesce($travellers, t.travellers)
RETURN t.id AS id
