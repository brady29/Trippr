// Hotels belong to an area (and so to a city), in the trip's library.
MATCH (t:Trip {id: $tripId}), (a:Area {id: $areaId})-[:FOR]->(t)
CREATE (h:Hotel {id: $id, name: $name, priceBasis: $priceBasis, sleeps: $sleeps, createdAt: $now, createdBy: $userId})
SET h.url = $url, h.lat = $lat, h.lon = $lon, h.priceCadPerNight = $priceCadPerNight, h.rating = $rating, h.notes = $notes
CREATE (h)-[:IN]->(a)
CREATE (h)-[:FOR]->(t)
RETURN h.id AS id
