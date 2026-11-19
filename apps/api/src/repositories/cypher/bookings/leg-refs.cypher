// Booking references and seats for one route's legs (editors and the owner only).
MATCH (:Route {id: $routeId})-[:HAS_STOP]->(:Stop)-[:ARRIVES_VIA]->(l:Leg)
RETURN l.id AS id, l.bookingRef AS bookingRef, l.seat AS seat
