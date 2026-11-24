// Record what the loaded vectors are (model, size, text version, how many, which bundle).
MERGE (e:EmbeddingIndex {id: 'activities'})
SET e.model = $model, e.version = $version, e.dims = $dims, e.textVersion = $textVersion, e.count = $count,
    e.bundleDate = $bundleDate, e.loadedAt = $loadedAt, e.revision = $revision
RETURN e.id AS id
