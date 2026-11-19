MATCH (r:Route {needsLegs: true})
SET r.needsLegs = null
