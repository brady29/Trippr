// Records one question, creating the thread on the first one.
MATCH (u:User {id: $userId})
MERGE (t:AssistantThread {id: $id})
  ON CREATE SET t.tripId = $tripId, t.messagesJson = '[]', t.updatedAt = $now, t.day = $day, t.dayCount = 0
MERGE (u)-[:ASKED]->(t)
WITH t, CASE WHEN t.day = $day THEN coalesce(t.dayCount, 0) + 1 ELSE 1 END AS next
SET t.dayCount = next, t.day = $day
RETURN t.dayCount AS count
