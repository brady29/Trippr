// Areas that have stay data from an older bundle but are not in this one lose it (the card then says there is none).
MATCH (a:Area)
WHERE a.stayBundleDate IS NOT NULL AND NOT a.id IN $keep
SET a.stay = null, a.stayScore = null, a.stayMedianPriceCad = null, a.staySnapshotDate = null,
    a.stayBundleDate = null, a.stayHotelCount = null, a.stayHash = null
