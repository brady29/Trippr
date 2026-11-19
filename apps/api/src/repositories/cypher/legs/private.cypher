MATCH (l:Leg {id: $legId})
RETURN l.id AS id, l.bookingRef AS bookingRef, l.seat AS seat
