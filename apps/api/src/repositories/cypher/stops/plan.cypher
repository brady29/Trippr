// An activity can only be planned at a stop in the activity's own city.
// The day, start time and length are only changed when the request sets them.
MATCH (s:Stop {id: $stopId})-[:AT]->(:City)<-[:IN]-(a:Activity {id: $activityId})
MERGE (s)-[p:PLANS]->(a)
SET p.day = CASE WHEN $setDay THEN $day ELSE p.day END,
    p.startTime = CASE WHEN $setTime THEN $startTime ELSE p.startTime END,
    p.durationMin = CASE WHEN $setDuration THEN $durationMin ELSE p.durationMin END
RETURN a.id AS activityId
