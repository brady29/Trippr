// The $k nearest activities to $vector by the vector index. FalkorDB's score is the cosine DISTANCE
// (0 = identical, 2 = opposite), so closest first is ASCENDING; the adapter turns it into similarity (1 - score).
// The vector must be vecf32(): a plain list is not indexed and not searched. Filtering is left to the caller
// (the index does not combine with property filters).
CALL db.idx.vector.queryNodes('Activity', 'embedding', $k, vecf32($vector)) YIELD node, score
RETURN node.id AS id, score
ORDER BY score ASC
