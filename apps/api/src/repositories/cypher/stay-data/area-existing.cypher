// Which Areas already carry stay data and its content hash (for the load job's dry run and summary).
MATCH (a:Area)
RETURN a.id AS id, a.stayHash AS hash
