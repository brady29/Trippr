// Catalogue categories in the trip's library (viewpoint, museum, ...), for the category menu.
MATCH (a:Activity)-[:FOR]->(:Trip {id: $tripId})
WHERE a.category IS NOT NULL AND coalesce(a.hidden, false) = false AND coalesce(a.listed, true) = true
RETURN a.category AS name, count(a) AS n
ORDER BY n DESC, name
