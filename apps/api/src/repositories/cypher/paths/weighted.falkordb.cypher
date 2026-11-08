// FalkorDB's built-in weighted shortest path over LINK edges.
MATCH (a:City {code: $from}), (b:City {code: $to})
CALL algo.SPpaths({sourceNode: a, targetNode: b, relTypes: ['LINK'], weightProp: $weight, maxLen: 8, pathCount: 1})
YIELD path, pathWeight
RETURN [n IN nodes(path) | n.code] AS cities,
       [e IN relationships(path) | e {.mode, .minutes, .costCad, .source, .asOf}] AS legs,
       pathWeight AS total
