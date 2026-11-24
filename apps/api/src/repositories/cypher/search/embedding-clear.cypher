// Forget every vector (an index rebuild after a model or size change). The index entries go with the property.
MATCH (a:Activity)
WHERE a.embeddingHash IS NOT NULL OR a.embedding IS NOT NULL
REMOVE a.embedding, a.embeddingHash
RETURN count(a) AS cleared
