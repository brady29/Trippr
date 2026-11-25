// The latest bundle that carried stay data: what the Data page and the Area card's coverage note read.
MERGE (l:StayLoad {id: 'latest'})
SET l.bundleDate = $bundleDate, l.loadedAt = $now, l.runDate = $runDate, l.coverageCities = $coverageCities,
    l.trippCities = $trippCities, l.stay = $stay
