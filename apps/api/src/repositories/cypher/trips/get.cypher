MATCH (t:Trip {id: $tripId})
RETURN t {.id, .name, .startDate, .homeCity, .travellers, .latestReturn, .budgetPerPerson} AS trip
