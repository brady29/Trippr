MATCH (:User {id: $userId})-[m:MEMBER_OF]->(:Trip {id: $tripId})
DELETE m
