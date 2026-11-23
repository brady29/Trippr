// (:Activity)-[:FROM_SOURCE {sourceId, fetchedAt, licence}]->(:DataSource): licences can be queried and the Data page counts by source.
UNWIND $links AS l
MATCH (a:Activity {id: l.activityId}), (d:DataSource {id: l.source})
MERGE (a)-[r:FROM_SOURCE]->(d)
SET r.sourceId = l.sourceId, r.fetchedAt = l.fetchedAt, r.licence = l.licence
