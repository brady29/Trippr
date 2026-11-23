// Provider requests already made today.
MATCH (r:FlightPriceRun {id: $id})
RETURN r.requests AS requests
