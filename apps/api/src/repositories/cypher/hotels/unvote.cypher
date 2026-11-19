MATCH (:User {id: $userId})-[v:VOTED]->(:Hotel {id: $hotelId})
DELETE v
