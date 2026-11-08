MATCH (r:Route)-[:HAS_STOP]->(s:Stop {id: $stopId})
WHERE r.version = $version
SET s.nights = coalesce($nights, s.nights),
    s.arriveMode = coalesce($arriveMode, s.arriveMode),
    s.arriveNote = coalesce($arriveNote, s.arriveNote),
    s.notes = coalesce($notes, s.notes),
    r.version = r.version + 1
RETURN r.id AS routeId, r.version AS version
