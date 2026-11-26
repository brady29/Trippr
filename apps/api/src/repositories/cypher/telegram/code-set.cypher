// A new link code for this member and trip; the old one stops working.
MATCH (u:User {id: $userId})-[:MEMBER_OF]->(t:Trip {id: $tripId})
MERGE (u)-[c:TELEGRAM_CODE]->(t)
SET c.code = $code, c.at = $now
RETURN c.code AS code
