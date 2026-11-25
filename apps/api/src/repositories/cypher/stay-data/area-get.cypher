// One Area with its stored stay card, for GET /areas/:id/stay.
MATCH (a:Area {id: $areaId})-[:IN]->(c:City)
RETURN a {.id, .name, .lat, .lon, .radiusKm, .stay, .stayBundleDate, .staySnapshotDate, .stayHotelCount} AS area,
       c.code AS cityCode, c.name AS cityName
