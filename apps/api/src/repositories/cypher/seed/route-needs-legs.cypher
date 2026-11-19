// A sample route added to an existing trip gets idea legs once the hubs exist.
MATCH (r:Route {id: $id})
SET r.needsLegs = true
