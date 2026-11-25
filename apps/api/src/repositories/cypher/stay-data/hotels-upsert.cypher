// Open-data hotels as catalogue Hotel nodes in their Area (and city). They have no price and are never booked;
// the group's own hotels (ids hotel_...) are never matched because only ids from the bundle are merged.
UNWIND $rows AS row
MATCH (a:Area {id: row.areaId})
MATCH (c:City {code: row.cityCode})
MERGE (h:Hotel {id: row.id})
ON CREATE SET h.createdAt = row.now, h.createdBy = 'pipeline'
SET h.catalogue = true, h.name = row.name, h.nameLocal = row.nameLocal, h.nameEn = row.nameEn, h.kind = row.kind,
    h.lat = row.lat, h.lon = row.lon, h.address = row.address, h.url = row.website, h.phone = row.phone,
    h.stars = row.stars, h.wikidataQid = row.wikidataQid, h.confidence = row.confidence, h.nSources = row.nSources,
    h.areaId = row.areaId, h.areaDistKm = row.areaDistKm, h.cityCode = row.cityCode,
    h.sources = row.sources, h.sourceIds = row.sourceIds, h.contentHash = row.contentHash,
    h.bundleDate = row.bundleDate, h.loadedAt = row.now
MERGE (h)-[:IN]->(a)
MERGE (h)-[:IN_CITY]->(c)
