// New catalogue places: ideas in the trip's library, never planned. MERGE so a retried load is harmless.
MATCH (t:Trip {id: $tripId})
UNWIND $rows AS row
MATCH (c:City {code: row.cityCode})
MERGE (a:Activity {id: row.id})
ON CREATE SET a.createdAt = row.now, a.createdBy = 'pipeline'
SET a.title = row.title, a.catalogue = true, a.listed = true, a.unlistedAt = null,
    a.category = row.category, a.score = row.score, a.rank = row.rank, a.nSources = row.nSources,
    a.lat = row.lat, a.lon = row.lon, a.address = row.address, a.website = row.website, a.phone = row.phone,
    a.openingHours = row.openingHours, a.nameLocal = row.nameLocal, a.wikidataQid = row.wikidataQid,
    a.sources = row.sources, a.sourceKeys = row.sourceKeys, a.sourceIds = row.sourceIds,
    a.catalogueId = row.id, a.contentHash = row.contentHash, a.bundleDate = row.bundleDate, a.loadedAt = row.now,
    a.placeStatus = 'placed', a.geoSource = 'catalogue', a.placedAt = row.now
MERGE (a)-[:IN]->(c)
MERGE (a)-[:FOR]->(t)
WITH a, row
MERGE (tg:Tag {name: row.tag})
MERGE (a)-[:TAGGED]->(tg)
