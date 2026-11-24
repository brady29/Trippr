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
    a.catalogueId = row.catalogueId, a.contentHash = row.contentHash, a.bundleDate = row.bundleDate, a.loadedAt = row.now,
    a.summary = CASE WHEN row.enriched THEN row.summary ELSE a.summary END,
    a.summaryAi = CASE WHEN row.enriched THEN row.summaryAi ELSE a.summaryAi END,
    a.aiLabel = CASE WHEN row.enriched THEN row.aiLabel ELSE a.aiLabel END,
    a.enrichTags = CASE WHEN row.enriched THEN row.enrichTags ELSE a.enrichTags END,
    a.durationMin = CASE WHEN row.enriched THEN row.durationMin ELSE a.durationMin END,
    a.bestTime = CASE WHEN row.enriched THEN row.bestTime ELSE a.bestTime END,
    a.indoor = CASE WHEN row.enriched THEN row.indoor ELSE a.indoor END,
    a.priceLevel = CASE WHEN row.enriched THEN row.priceLevel ELSE a.priceLevel END,
    a.goodFor = CASE WHEN row.enriched THEN row.goodFor ELSE a.goodFor END,
    a.displayName = CASE WHEN row.enriched THEN row.displayName ELSE a.displayName END,
    a.genericName = CASE WHEN row.enriched THEN row.genericName ELSE a.genericName END,
    a.enrichModel = CASE WHEN row.enriched THEN row.enrichModel ELSE a.enrichModel END,
    a.enrichPromptVersion = CASE WHEN row.enriched THEN row.enrichPromptVersion ELSE a.enrichPromptVersion END,
    a.enrichedAt = CASE WHEN row.enriched THEN row.enrichedAt ELSE a.enrichedAt END
WITH a, row
MERGE (tg:Tag {name: row.tag})
MERGE (a)-[:TAGGED]->(tg)
