UNWIND $serves AS row
MATCH (x:Hub {hubId: row.hubId}), (c:City {code: row.cityCode})
MERGE (x)-[:SERVES]->(c)
