MATCH (t:Trip {id: $tripId}), (c:City {code: $cityCode})
CREATE (a:Area {id: $id, name: $name, vibes: $vibes, createdAt: $now, createdBy: $userId})
SET a.lat = $lat, a.lon = $lon, a.note = $note, a.radiusKm = $radiusKm
CREATE (a)-[:IN]->(c)
CREATE (a)-[:FOR]->(t)
RETURN a.id AS id
