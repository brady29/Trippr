// A route's snapshots, oldest first.
MATCH (p:FlightPrice {routeKey: $routeKey})
RETURN p.snapshotDate AS snapshotDate, p.priceCad AS priceCad, p.airline AS airline, p.stops AS stops,
       p.windowJson AS windowJson, p.prevLowCad AS prevLowCad, p.dropPct AS dropPct
ORDER BY snapshotDate
LIMIT $limit
