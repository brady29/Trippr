// The bundle the load job put in the graph most recently.
MATCH (l:DataLoad)
RETURN l {.id, .bundleDate, .loadedAt, .input, .pipelineVersion, .counts, .checks, .evals} AS load
ORDER BY l.loadedAt DESC
LIMIT 1
