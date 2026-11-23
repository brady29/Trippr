// Every activity, with how much the group has used it, so the load job can match the bundle's places to
// what is already there (by id, by source keys, or by name for hand-written activities) and decide what is safe to change.
MATCH (a:Activity)-[:IN]->(c:City)
OPTIONAL MATCH (:User)-[v:VOTED]->(a)
WITH a, c, count(v) AS votes
OPTIONAL MATCH (:Stop)-[p:PLANS]->(a)
WITH a, c, votes, count(p) AS plans
OPTIONAL MATCH (cm:Comment)-[:ON]->(a)
WITH a, c, votes, plans, count(cm) AS comments
RETURN a {.id, .title, .mapsQuery, .lat, .lon, .placeStatus, .geoSource, .catalogue, .adopted, .catalogueId, .sourceKeys,
          .listed, .hidden, .edited, .contentHash} AS activity,
       c.code AS cityCode, c.name AS cityName, votes, plans, comments
