// Who on the trip sent this email, by the address on their account.
MATCH (u:User)-[m:MEMBER_OF]->(:Trip {id: $tripId})
WHERE u.email IS NOT NULL AND toLower(u.email) = toLower($email)
RETURN u.id AS id, u.name AS name, m.role AS role
LIMIT 1
