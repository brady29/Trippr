// Bulk-copy hotel stays onto stops (route duplication).
UNWIND $stays AS row
MATCH (s:Stop {id: row.stopId}), (h:Hotel {id: row.hotelId})
CREATE (s)-[st:STAYS_AT]->(h)
SET st.status = row.status, st.rooms = row.rooms, st.arrive = row.arrive, st.depart = row.depart, st.freeCancelUntil = row.freeCancelUntil, st.at = row.at
