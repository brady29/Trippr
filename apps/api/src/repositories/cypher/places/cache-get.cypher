// A remembered geocoder answer (found or not) for a normalised query.
MATCH (g:GeocodeCache {key: $key})
RETURN g {.found, .lat, .lon, .address, .osmId, .fetchedAt} AS hit
