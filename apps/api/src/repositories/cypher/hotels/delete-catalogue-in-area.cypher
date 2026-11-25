// Open-data hotel suggestions of an Area (loaded from the bundle); the group's own hotels are never matched.
MATCH (h:Hotel {catalogue: true})-[:IN]->(:Area {id: $areaId})
DETACH DELETE h
