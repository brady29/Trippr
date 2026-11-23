// Provenance edges belong to the pipeline: they are dropped and re-made from the bundle for each place it lists.
MATCH (a:Activity)-[r:FROM_SOURCE]->(:DataSource)
WHERE a.id IN $ids
DELETE r
