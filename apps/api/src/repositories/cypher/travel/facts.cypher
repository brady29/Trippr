// What two places have: coordinates, country, and the stations and airports that serve them.
MATCH (c:City)-[:IN]->(k:Country)
WHERE c.code IN $codes
OPTIONAL MATCH (own:Hub {cityCode: c.code})
WITH c, k, collect(DISTINCT {kind: own.kind, stationKind: own.stationKind}) AS owned
OPTIONAL MATCH (served:Hub)-[:SERVES]->(c)
WITH c, k, owned, collect(DISTINCT {kind: served.kind, stationKind: served.stationKind}) AS servedBy
RETURN c.code AS code, c.name AS name, c.lat AS lat, c.lon AS lon, k.iso AS countryIso, owned + servedBy AS hubs
