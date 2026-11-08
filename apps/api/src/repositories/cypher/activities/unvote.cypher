MATCH (:User {id: $userId})-[v:VOTED]->(:Activity {id: $activityId})
DELETE v
