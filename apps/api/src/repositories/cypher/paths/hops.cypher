// Query 6 (stretch): fewest hops. FalkorDB only allows shortestPath in WITH/RETURN.
MATCH (a:City {code: $from}), (b:City {code: $to})
WITH a, b, shortestPath((a)-[:LINK*1..8]->(b)) AS p
WHERE p IS NOT NULL
RETURN [n IN nodes(p) | n.code] AS cities,
       [e IN relationships(p) | e {.mode, .minutes, .costCad, .source, .asOf}] AS legs
