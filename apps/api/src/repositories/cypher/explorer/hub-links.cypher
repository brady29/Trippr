// One LINK edge per direction and mode between hubs, as for cities.
UNWIND $links AS row
MATCH (a:Hub {hubId: row.from}), (b:Hub {hubId: row.to})
MERGE (a)-[l:LINK {mode: row.mode}]->(b)
SET l.minutes = row.minutes, l.costCad = row.costCad, l.note = row.note, l.source = row.source, l.asOf = row.asOf
