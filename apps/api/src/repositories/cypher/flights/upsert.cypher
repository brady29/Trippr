// One snapshot per provider, route, departure date and day. Re-running a day overwrites it.
MERGE (p:FlightPrice {id: $id})
SET p.routeKey = $routeKey, p.provider = $provider, p.origin = $origin, p.destination = $destination,
    p.departDate = $departDate, p.snapshotDate = $snapshotDate, p.priceCad = $priceCad, p.airline = $airline,
    p.stops = $stops, p.windowJson = $windowJson, p.sample = $sample, p.prevLowCad = $prevLowCad,
    p.dropPct = $dropPct, p.fetchedAt = $fetchedAt
RETURN p.id AS id
