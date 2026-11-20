// Set or clear an activity's pin. A null status leaves the status as it was.
MATCH (a:Activity {id: $activityId})
SET a.lat = $lat, a.lon = $lon, a.address = $address,
    a.placeStatus = coalesce($status, a.placeStatus),
    a.geoSource = $source, a.placedAt = $now,
    a.mapsUrl = CASE WHEN $setMapsUrl THEN $mapsUrl ELSE a.mapsUrl END
RETURN a.id AS id
