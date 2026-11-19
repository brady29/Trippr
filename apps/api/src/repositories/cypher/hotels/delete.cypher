// Removes the hotel from every stop that shortlisted or booked it, and its votes.
MATCH (h:Hotel {id: $hotelId})
DETACH DELETE h
