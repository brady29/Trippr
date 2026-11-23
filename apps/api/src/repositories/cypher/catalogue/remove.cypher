// Catalogue places that dropped out of the bundle and that nobody used: removed. Only ever catalogue nodes.
MATCH (a:Activity)
WHERE a.id IN $ids AND a.catalogue = true
DETACH DELETE a
