// One LINK edge per direction; MERGE on mode so a city pair can have a train and a flight.
UNWIND $links AS row
MATCH (a:City {code: row.from}), (b:City {code: row.to})
MERGE (a)-[l:LINK {mode: row.mode}]->(b)
SET l.minutes = row.minutes, l.costCad = row.costCad, l.note = row.note, l.source = row.source, l.asOf = row.asOf
