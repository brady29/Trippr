// Who a link code belongs to, and their role on the trip now.
MATCH (u:User)-[c:TELEGRAM_CODE {code: $code}]->(t:Trip)
OPTIONAL MATCH (u)-[m:MEMBER_OF]->(t)
RETURN t.id AS tripId, t.name AS tripName, u.id AS userId, u.name AS userName, m.role AS role
LIMIT 1
