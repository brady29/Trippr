UNWIND $cities AS row
MATCH (k:Country {iso: row.country})
MERGE (c:City {code: row.code})
SET c.name = row.name, c.lat = row.lat, c.lon = row.lon, c.kind = row.kind, c.tz = row.tz
MERGE (c)-[:IN]->(k)
