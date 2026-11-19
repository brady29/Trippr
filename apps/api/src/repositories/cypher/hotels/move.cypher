// Move a hotel to another area of the same trip.
MATCH (h:Hotel {id: $hotelId})-[old:IN]->(:Area)
MATCH (a:Area {id: $areaId})
DELETE old
CREATE (h)-[:IN]->(a)
