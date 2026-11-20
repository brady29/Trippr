// Created once, attached to a city, available to every route that stops there.
MATCH (t:Trip {id: $tripId}), (c:City {code: $cityCode})
CREATE (a:Activity {id: $id, title: $title, createdAt: $now, createdBy: $userId})
SET a.url = $url, a.when = $when, a.costCad = $costCad,
    a.website = $website, a.ticketUrl = $ticketUrl, a.reserveUrl = $reserveUrl, a.placeStatus = 'unplaced'
CREATE (a)-[:IN]->(c)
CREATE (a)-[:FOR]->(t)
WITH a
UNWIND $tags AS tagName
MERGE (tg:Tag {name: tagName})
MERGE (a)-[:TAGGED]->(tg)
