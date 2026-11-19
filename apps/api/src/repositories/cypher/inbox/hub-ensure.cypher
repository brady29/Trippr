// A station or airport named in a confirmation that the reference data doesn't have yet.
MERGE (h:Hub {hubId: $hubId})
ON CREATE SET h.kind = $kind, h.code = $code, h.name = $name, h.cityCode = $cityCode, h.cityName = $cityName,
              h.lat = $lat, h.lon = $lon, h.source = 'inbox'
RETURN h.hubId AS hubId, h.kind AS kind
