MATCH (u:User)-[m:MEMBER_OF]->(:Trip {id: $tripId})
RETURN u.id AS id, u.name AS name, m.role AS role
ORDER BY u.name
