// Questions this member asked today, across all their trips.
MATCH (:User {id: $userId})-[:ASKED]->(t:AssistantThread)
WHERE t.day = $day
RETURN coalesce(sum(t.dayCount), 0) AS used
