// Tags in use in the trip's library (the five colour tags and anything the group added), for the tag menu.
MATCH (a:Activity)-[:FOR]->(:Trip {id: $tripId}), (a)-[:TAGGED]->(tg:Tag)
WHERE coalesce(a.hidden, false) = false AND coalesce(a.listed, true) = true
RETURN tg.name AS name, count(a) AS n
ORDER BY n DESC, name
