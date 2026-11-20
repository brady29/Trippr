// Replaces the thread's messages (also used to clear it; the day's count stays).
MATCH (t:AssistantThread {id: $id})
SET t.messagesJson = $messagesJson, t.updatedAt = $now
RETURN t.id AS id
