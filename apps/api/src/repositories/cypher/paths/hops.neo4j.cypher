// Query 6 (stretch): fewest hops, Neo4j's MATCH form.
MATCH (a:City {code: $from}), (b:City {code: $to})
MATCH p = shortestPath((a)-[:LINK*1..8]->(b))
RETURN [n IN nodes(p) | n.code] AS cities,
       [e IN relationships(p) | e {.mode, .minutes, .costCad, .source, .asOf}] AS legs
