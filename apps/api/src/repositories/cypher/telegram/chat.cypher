// The trip a chat feeds, and the member who linked it with their role now.
MATCH (c:TelegramChat {chatId: $chatId})-[:FEEDS]->(t:Trip)
OPTIONAL MATCH (c)-[:LINKED_BY]->(u:User)
OPTIONAL MATCH (u)-[m:MEMBER_OF]->(t)
RETURN t.id AS tripId, t.name AS tripName, u.id AS userId, u.name AS userName, m.role AS role
LIMIT 1
