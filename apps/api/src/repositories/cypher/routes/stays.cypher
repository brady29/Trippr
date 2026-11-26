// Hotels shortlisted, chosen or booked for each stop of a route.
MATCH (:Route {id: $routeId})-[:HAS_STOP]->(s:Stop)-[st:STAYS_AT]->(h:Hotel)-[:IN]->(ar:Area)
RETURN s.id AS stopId, st.status AS status, st.rooms AS rooms, st.arrive AS arrive, st.depart AS depart, st.freeCancelUntil AS freeCancelUntil, st.at AS at,
       h {.id, .name, .url, .priceCadPerNight, .priceBasis, .sleeps, .lat, .lon} AS hotel,
       ar.id AS areaId, ar.name AS areaName
