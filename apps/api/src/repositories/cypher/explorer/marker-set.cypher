MERGE (m:Migration {id: $id})
ON CREATE SET m.at = $now
RETURN m.id AS id
