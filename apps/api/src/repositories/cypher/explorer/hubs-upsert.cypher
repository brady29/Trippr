// Stations and airports are shared reference data, refreshed on every run.
UNWIND $hubs AS h
MERGE (x:Hub {hubId: h.hubId})
SET x.kind = h.kind, x.code = h.code, x.name = h.name, x.nameLocal = h.nameLocal, x.stationKind = h.stationKind,
    x.lat = h.lat, x.lon = h.lon, x.cityCode = h.cityCode, x.cityName = h.cityName, x.source = h.source, x.asOf = h.asOf
