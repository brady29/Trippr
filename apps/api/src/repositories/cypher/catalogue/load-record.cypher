// One DataLoad per bundle date loaded: what the Data page shows as the latest load.
MERGE (l:DataLoad {id: $id})
SET l.bundleDate = $bundleDate, l.loadedAt = $now, l.input = $input, l.pipelineVersion = $pipelineVersion,
    l.counts = $counts, l.checks = $checks, l.evals = $evals, l.createdAt = $createdAt
