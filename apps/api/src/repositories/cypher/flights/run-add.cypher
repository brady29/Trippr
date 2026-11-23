// Count provider requests against the day's budget.
MERGE (r:FlightPriceRun {id: $id})
ON CREATE SET r.requests = 0, r.day = $day, r.provider = $provider
SET r.requests = r.requests + $n, r.updatedAt = $now
RETURN r.requests AS requests
