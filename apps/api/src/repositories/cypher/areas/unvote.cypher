MATCH (:User {id: $userId})-[v:VOTED]->(:Area {id: $areaId})
DELETE v
