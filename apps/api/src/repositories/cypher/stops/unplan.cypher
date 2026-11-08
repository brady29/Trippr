MATCH (:Stop {id: $stopId})-[p:PLANS]->(:Activity {id: $activityId})
DELETE p
