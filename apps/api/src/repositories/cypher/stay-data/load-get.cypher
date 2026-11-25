MATCH (l:StayLoad {id: 'latest'})
RETURN l {.bundleDate, .loadedAt, .runDate, .coverageCities, .trippCities, .stay} AS load
