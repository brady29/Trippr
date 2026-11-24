// The $k nearest activities to $vector by the vector index activity_embedding. Neo4j's score is a similarity in
// 0..1, (1 + cosine) / 2, best first; the adapter turns it into cosine (2 * score - 1). The query vector goes
// through toFloat() because the driver sends whole numbers as integers.
CALL db.index.vector.queryNodes('activity_embedding', $k, [x IN $vector | toFloat(x)]) YIELD node, score
RETURN node.id AS id, score
ORDER BY score DESC
