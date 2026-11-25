// A covered city's summary (no cells), for the Area card's comparison with the city.
MATCH (m:StayMarket {id: $cityCode})
RETURN m {.cityCode, .name, .snapshotDate, .bundleDate, .city} AS market
