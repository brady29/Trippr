// A hand-written activity that is the same place as a catalogue place keeps its id, votes, comments, plans,
// title, tags and anything the group filled in. The pipeline only fills what is empty (a missing pin, website,
// phone, ...) and records where the place comes from. It stays the group's own idea (catalogue is not set).
UNWIND $rows AS row
MATCH (a:Activity {id: row.activityId})
// Enrichment follows the same rule: a summary the group wrote itself (no AI flag) is never replaced; a field is
// filled only while it is empty, or refreshed when the pipeline filled it earlier (enrichedAt is set).
WITH a, row, (a.lat IS NULL AND (a.placeStatus IS NULL OR a.placeStatus IN ['unplaced', 'not_found'])) AS pinIsEmpty,
     (row.enriched AND (a.summary IS NULL OR coalesce(a.summaryAi, false))) AS takeSummary,
     (row.enriched AND a.enrichedAt IS NOT NULL) AS refill
SET a.adopted = true, a.catalogueId = row.catalogueId,
    a.lat = CASE WHEN pinIsEmpty THEN row.lat ELSE a.lat END,
    a.lon = CASE WHEN pinIsEmpty THEN row.lon ELSE a.lon END,
    a.address = CASE WHEN pinIsEmpty THEN coalesce(a.address, row.address) ELSE a.address END,
    a.placeStatus = CASE WHEN pinIsEmpty THEN 'placed' ELSE a.placeStatus END,
    a.geoSource = CASE WHEN pinIsEmpty THEN 'catalogue' ELSE a.geoSource END,
    a.placedAt = CASE WHEN pinIsEmpty THEN row.now ELSE a.placedAt END,
    a.website = coalesce(a.website, row.website), a.phone = coalesce(a.phone, row.phone),
    a.openingHours = coalesce(a.openingHours, row.openingHours), a.nameLocal = coalesce(a.nameLocal, row.nameLocal),
    a.wikidataQid = coalesce(a.wikidataQid, row.wikidataQid),
    a.category = row.category, a.score = row.score, a.rank = row.rank, a.nSources = row.nSources,
    a.sources = row.sources, a.sourceKeys = row.sourceKeys, a.sourceIds = row.sourceIds,
    a.contentHash = row.contentHash, a.bundleDate = row.bundleDate, a.loadedAt = row.now,
    a.summary = CASE WHEN takeSummary THEN row.summary ELSE a.summary END,
    a.summaryAi = CASE WHEN takeSummary THEN row.summaryAi ELSE a.summaryAi END,
    a.aiLabel = CASE WHEN takeSummary THEN row.aiLabel ELSE a.aiLabel END,
    a.enrichTags = CASE WHEN row.enriched AND (refill OR a.enrichTags IS NULL) THEN row.enrichTags ELSE a.enrichTags END,
    a.durationMin = CASE WHEN row.enriched AND (refill OR a.durationMin IS NULL) THEN row.durationMin ELSE a.durationMin END,
    a.bestTime = CASE WHEN row.enriched AND (refill OR a.bestTime IS NULL) THEN row.bestTime ELSE a.bestTime END,
    a.indoor = CASE WHEN row.enriched AND (refill OR a.indoor IS NULL) THEN row.indoor ELSE a.indoor END,
    a.priceLevel = CASE WHEN row.enriched AND (refill OR a.priceLevel IS NULL) THEN row.priceLevel ELSE a.priceLevel END,
    a.goodFor = CASE WHEN row.enriched AND (refill OR a.goodFor IS NULL) THEN row.goodFor ELSE a.goodFor END,
    a.displayName = CASE WHEN row.enriched AND (refill OR a.displayName IS NULL) THEN row.displayName ELSE a.displayName END,
    a.genericName = CASE WHEN row.enriched AND (refill OR a.genericName IS NULL) THEN row.genericName ELSE a.genericName END,
    a.enrichModel = CASE WHEN row.enriched THEN row.enrichModel ELSE a.enrichModel END,
    a.enrichPromptVersion = CASE WHEN row.enriched THEN row.enrichPromptVersion ELSE a.enrichPromptVersion END,
    a.enrichedAt = CASE WHEN row.enriched THEN row.enrichedAt ELSE a.enrichedAt END
