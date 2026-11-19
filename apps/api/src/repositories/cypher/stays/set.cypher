// Shortlist, choose or book a hotel for a stop. A route-structure write.
MATCH (t:Trip)-[:HAS_ROUTE]->(r:Route)-[:HAS_STOP]->(s:Stop {id: $stopId})
WHERE r.version = $version
MATCH (h:Hotel {id: $hotelId})-[:FOR]->(t)
SET r.version = r.version + 1
MERGE (s)-[st:STAYS_AT]->(h)
SET st.status = $status, st.rooms = $rooms, st.at = $now, st.arrive = $arrive, st.depart = $depart
RETURN r.id AS routeId, r.version AS version
