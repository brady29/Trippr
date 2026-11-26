// A member's link code for a trip's Telegram bot.
MATCH (:User {id: $userId})-[c:TELEGRAM_CODE]->(:Trip {id: $tripId})
RETURN c.code AS code
