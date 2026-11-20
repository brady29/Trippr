MERGE (g:GeocodeCache {key: $key})
SET g.found = $found, g.lat = $lat, g.lon = $lon, g.address = $address, g.osmId = $osmId, g.fetchedAt = $now
RETURN g.key AS key
