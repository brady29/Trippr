// Point a Telegram chat at a trip, linked by a member. A chat feeds one trip at a time.
MATCH (t:Trip {id: $tripId}), (u:User {id: $userId})
MERGE (c:TelegramChat {chatId: $chatId})
SET c.title = $title, c.kind = $kind, c.linkedAt = $now
WITH c, t, u
OPTIONAL MATCH (c)-[old]->()
WITH c, t, u, collect(old) AS olds
FOREACH (r IN olds | DELETE r)
CREATE (c)-[:FEEDS]->(t)
CREATE (c)-[:LINKED_BY]->(u)
RETURN c.chatId AS chatId
