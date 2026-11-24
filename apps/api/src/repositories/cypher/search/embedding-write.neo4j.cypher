// Set the vector on each activity with the procedure that stores it as a compact float32 array the vector index accepts.
UNWIND $rows AS row
MATCH (a:Activity {id: row.activityId})
CALL db.create.setNodeVectorProperty(a, 'embedding', [x IN row.vector | toFloat(x)])
SET a.embeddingHash = row.hash
RETURN count(a) AS written
