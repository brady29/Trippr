// Which catalogue places are in the graph and which vector each carries (by the pipeline's content hash), so the load
// job writes only what changed. The vector itself is never returned here.
MATCH (a:Activity)
WHERE a.catalogueId IS NOT NULL
RETURN a.catalogueId AS placeId, a.id AS id, a.embeddingHash AS hash
