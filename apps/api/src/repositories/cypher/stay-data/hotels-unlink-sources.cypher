MATCH (h:Hotel)-[r:FROM_SOURCE]->(:DataSource)
WHERE h.catalogue = true AND h.id IN $ids
DELETE r
