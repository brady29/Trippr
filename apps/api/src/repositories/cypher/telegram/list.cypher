// The chats feeding a trip.
MATCH (c:TelegramChat)-[:FEEDS]->(:Trip {id: $tripId})
OPTIONAL MATCH (c)-[:LINKED_BY]->(u:User)
RETURN c.chatId AS chatId, c.title AS title, c.kind AS kind, c.linkedAt AS linkedAt, u.name AS linkedBy
ORDER BY c.linkedAt
