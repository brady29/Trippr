// Set the vector on each activity. vecf32() makes it a float32 vector the index can use; a plain list is silently not indexed.
UNWIND $rows AS row
MATCH (a:Activity {id: row.activityId})
SET a.embedding = vecf32(row.vector), a.embeddingHash = row.hash
RETURN count(a) AS written
