// A hand-written activity that is the same place as a catalogue place keeps its id, votes, comments, plans,
// title, tags and anything the group filled in. The pipeline only fills what is empty (a missing pin, website,
// phone, ...) and records where the place comes from. It stays the group's own idea (catalogue is not set).
UNWIND $rows AS row
MATCH (a:Activity {id: row.activityId})
WITH a, row, (a.lat IS NULL AND (a.placeStatus IS NULL OR a.placeStatus IN ['unplaced', 'not_found'])) AS pinIsEmpty
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
    a.contentHash = row.contentHash, a.bundleDate = row.bundleDate, a.loadedAt = row.now
