MATCH (h:Hub)
WHERE h.hubId IN $ids
RETURN h {.hubId, .kind, .code, .name, .nameLocal, .stationKind, .lat, .lon, .cityCode, .cityName} AS hub
