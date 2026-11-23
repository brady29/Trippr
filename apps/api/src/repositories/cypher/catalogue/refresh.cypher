// A catalogue place already in the graph, listed again by the new bundle. The pipeline's fields are refreshed;
// what people did is not: votes, comments, plans and tags are other nodes and edges, a title or website someone
// edited stays (edited), and a pin only moves while it is still the catalogue's own (geoSource 'catalogue').
UNWIND $rows AS row
MATCH (a:Activity {id: row.activityId})
WITH a, row, coalesce(a.edited, false) AS edited, a.geoSource = 'catalogue' AS ownPin
SET a.title = CASE WHEN edited THEN a.title ELSE row.title END,
    a.website = CASE WHEN edited THEN a.website ELSE row.website END,
    a.lat = CASE WHEN ownPin THEN row.lat ELSE a.lat END,
    a.lon = CASE WHEN ownPin THEN row.lon ELSE a.lon END,
    a.address = CASE WHEN ownPin THEN row.address ELSE a.address END,
    a.listed = true, a.unlistedAt = null,
    a.category = row.category, a.score = row.score, a.rank = row.rank, a.nSources = row.nSources,
    a.phone = row.phone, a.openingHours = row.openingHours, a.nameLocal = row.nameLocal, a.wikidataQid = row.wikidataQid,
    a.sources = row.sources, a.sourceKeys = row.sourceKeys, a.sourceIds = row.sourceIds,
    a.catalogueId = row.catalogueId, a.contentHash = row.contentHash, a.bundleDate = row.bundleDate, a.loadedAt = row.now
WITH a, row
MERGE (tg:Tag {name: row.tag})
MERGE (a)-[:TAGGED]->(tg)
