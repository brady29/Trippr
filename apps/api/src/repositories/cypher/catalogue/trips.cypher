// The trips whose activity library the load job can add places to.
MATCH (t:Trip)
RETURN t.id AS id, t.name AS name
ORDER BY t.createdAt, t.id
