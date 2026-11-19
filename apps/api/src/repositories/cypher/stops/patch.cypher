// Cost estimates: a false set-flag leaves them alone; true with null clears them.
MATCH (r:Route)-[:HAS_STOP]->(s:Stop {id: $stopId})
WHERE r.version = $version
SET s.nights = coalesce($nights, s.nights),
    s.arriveMode = coalesce($arriveMode, s.arriveMode),
    s.arriveNote = coalesce($arriveNote, s.arriveNote),
    s.notes = coalesce($notes, s.notes),
    s.stayCadPerNight = CASE WHEN $setStay THEN $stayCadPerNight ELSE s.stayCadPerNight END,
    s.arriveCostCad = CASE WHEN $setArriveCost THEN $arriveCostCad ELSE s.arriveCostCad END,
    r.version = r.version + 1
RETURN r.id AS routeId, r.version AS version
