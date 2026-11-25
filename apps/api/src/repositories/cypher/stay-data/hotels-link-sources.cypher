// (:Hotel)-[:FROM_SOURCE {sourceId, fetchedAt, licence}]->(:DataSource), like the catalogue's places.
UNWIND $links AS l
MATCH (h:Hotel {id: l.hotelId}), (d:DataSource {id: l.source})
MERGE (h)-[r:FROM_SOURCE {sourceId: l.sourceId}]->(d)
SET r.fetchedAt = l.fetchedAt, r.licence = l.licence
