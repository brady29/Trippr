MATCH (a:Area {id: $areaId})
SET a.name = coalesce($name, a.name),
    a.vibes = coalesce($vibes, a.vibes),
    a.lat = CASE WHEN $setLat THEN $lat ELSE a.lat END,
    a.lon = CASE WHEN $setLon THEN $lon ELSE a.lon END,
    a.note = CASE WHEN $setNote THEN $note ELSE a.note END,
    a.radiusKm = CASE WHEN $setRadiusKm THEN $radiusKm ELSE a.radiusKm END
RETURN a.id AS id
