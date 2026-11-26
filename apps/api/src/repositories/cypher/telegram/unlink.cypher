// Stop a chat feeding a trip ($tripId null: whatever trip it feeds, as /unlink in the chat does).
MATCH (c:TelegramChat {chatId: $chatId})-[:FEEDS]->(t:Trip)
WHERE $tripId IS NULL OR t.id = $tripId
WITH c LIMIT 1
DETACH DELETE c
RETURN 1 AS ok
