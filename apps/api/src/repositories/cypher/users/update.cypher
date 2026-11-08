MATCH (u:User {id: $id})
SET u.name = coalesce($name, u.name), u.email = coalesce($email, u.email)
RETURN u.id AS id, u.name AS name, u.email AS email
