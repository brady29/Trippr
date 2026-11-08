// An activity can only be planned at a stop in the activity's own city.
MATCH (s:Stop {id: $stopId})-[:AT]->(:City)<-[:IN]-(a:Activity {id: $activityId})
MERGE (s)-[p:PLANS]->(a)
SET p.day = $day
RETURN a.id AS activityId
