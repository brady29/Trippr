// Neo4j builds an index in the background and cannot query it while it is POPULATING.
CALL db.awaitIndexes(300)
