// Activities belong to a city (and to the trip's library), never to a route.
MATCH (t:Trip {id: $tripId})
UNWIND $activities AS row
MATCH (c:City {code: row.city})
MERGE (a:Activity {id: row.id})
SET a.title = row.title, a.url = row.url, a.when = row.when, a.costCad = row.costCad, a.mapsQuery = row.mapsQuery
MERGE (a)-[:IN]->(c)
MERGE (a)-[:FOR]->(t)
WITH a, row
UNWIND row.tags AS tagName
MERGE (tg:Tag {name: tagName})
MERGE (a)-[:TAGGED]->(tg)
