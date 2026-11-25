// The colour tags of the places planned in OTHER cities, in any route of the trip: how many distinct places each tag has.
MATCH (:Trip {id: $tripId})-[:HAS_ROUTE]->(:Route)-[:HAS_STOP]->(:Stop)-[:PLANS]->(a:Activity)-[:IN]->(c:City), (a)-[:TAGGED]->(tg:Tag)
WHERE c.code <> $cityCode AND coalesce(a.hidden, false) = false
RETURN tg.name AS tag, count(DISTINCT a.id) AS places
ORDER BY tag
