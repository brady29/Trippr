// What the group liked and disliked in OTHER cities of the trip, as colour tags (culture, food, ...): the net votes
// each tag collected. Used only when nothing is liked in the stop's own city yet.
MATCH (:User)-[v:VOTED]->(a:Activity)-[:FOR]->(:Trip {id: $tripId}), (a)-[:IN]->(c:City), (a)-[:TAGGED]->(tg:Tag)
WHERE c.code <> $cityCode AND coalesce(a.hidden, false) = false AND v.value <> 0
RETURN tg.name AS tag, sum(v.value) AS weight
ORDER BY tag
