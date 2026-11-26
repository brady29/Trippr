// Telegram update ids only grow, so anything at or below the last one handled is a retry.
MERGE (b:TelegramBot {id: 'bot'})
WITH b, coalesce(b.lastUpdateId, -1) AS last
SET b.lastUpdateId = CASE WHEN $updateId > last THEN $updateId ELSE last END
RETURN $updateId > last AS fresh
