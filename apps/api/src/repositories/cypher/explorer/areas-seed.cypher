// Suggested areas join the trip's library once; later edits are never overwritten.
MATCH (t:Trip {id: $tripId})
UNWIND $areas AS row
MATCH (c:City {code: row.city})
MERGE (a:Area {id: row.id})
ON CREATE SET a.name = row.name, a.vibes = row.vibes, a.lat = row.lat, a.lon = row.lon, a.note = row.note,
              a.source = row.source, a.createdAt = $now
MERGE (a)-[:IN]->(c)
MERGE (a)-[:FOR]->(t)
