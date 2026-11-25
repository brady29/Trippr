// The open-data hotels of one Area; the API sorts and trims them (null ordering differs between databases).
MATCH (h:Hotel {catalogue: true})-[:IN]->(a:Area {id: $areaId})
RETURN h {.id, .name, .nameLocal, .kind, .lat, .lon, .address, .url, .stars, .nSources, .areaDistKm, .sources} AS hotel
