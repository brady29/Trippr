// Stay analytics for seeded Areas (from the bundle's stay_unit rows): the card as JSON plus a few scalars for ranking.
// Only Areas that exist in the graph are touched; nothing is created.
UNWIND $rows AS row
MATCH (a:Area {id: row.areaId})
SET a.stay = row.stay, a.stayScore = row.score, a.stayMedianPriceCad = row.medianPriceCad,
    a.staySnapshotDate = row.snapshotDate, a.stayBundleDate = row.bundleDate, a.stayHotelCount = row.hotelCount,
    a.stayHash = row.hash
