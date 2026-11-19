// At most one chosen or booked hotel per stop: the others go back to the shortlist.
MATCH (:Stop {id: $stopId})-[st:STAYS_AT]->(h:Hotel)
WHERE h.id <> $hotelId AND st.status IN ['chosen', 'booked']
SET st.status = 'shortlist', st.arrive = null, st.depart = null
