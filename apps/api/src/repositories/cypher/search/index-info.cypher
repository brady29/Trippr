// What the loaded vectors are. One node, written by the load job after it wrote the vectors.
MATCH (e:EmbeddingIndex {id: 'activities'})
RETURN e.model AS model, e.version AS version, e.dims AS dims, e.textVersion AS textVersion, e.count AS count,
       e.bundleDate AS bundleDate, e.loadedAt AS loadedAt, e.revision AS revision
