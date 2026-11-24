// A second spelling of the drop, tried when the first leaves the index answering (FalkorDB's own syntax for a typed index
// has changed between versions; the generic form drops the index on this property whatever its type).
DROP INDEX FOR (n:Activity) ON (n.embedding)
