// Map a verified sign-in token to a User node, creating it on first sign-in.
MERGE (u:User {id: $id})
ON CREATE SET u.name = coalesce($name, 'Traveller'), u.email = $email, u.createdAt = $now
ON MATCH SET u.name = coalesce($name, u.name), u.email = coalesce($email, u.email)
RETURN u.id AS id, u.name AS name, u.email AS email
