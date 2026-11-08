MATCH (t:Trip {id: $tripId})
RETURN t {.id, .name, .startDate, .homeCity} AS trip
