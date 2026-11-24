// Forget the record of loaded vectors (part of an index rebuild).
MATCH (e:EmbeddingIndex {id: 'activities'})
DELETE e
RETURN 1 AS done
