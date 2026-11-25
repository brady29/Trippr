// One StayMarket per city Inside Airbnb covers: the city summary, neighbourhoods and H3 cells as compact JSON for the map layer.
UNWIND $rows AS row
MATCH (c:City {code: row.cityCode})
MERGE (m:StayMarket {id: row.cityCode})
SET m.cityCode = row.cityCode, m.name = row.name, m.snapshotDate = row.snapshotDate, m.bundleDate = row.bundleDate,
    m.city = row.city, m.neighbourhoods = row.neighbourhoods, m.cells = row.cells, m.cellCount = row.cellCount,
    m.minLat = row.minLat, m.maxLat = row.maxLat, m.minLon = row.minLon, m.maxLon = row.maxLon,
    m.hash = row.hash, m.loadedAt = $now
MERGE (m)-[:FOR_CITY]->(c)
