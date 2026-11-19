// Only called for an area with no hotels (the API checks first).
MATCH (a:Area {id: $areaId})
DETACH DELETE a
