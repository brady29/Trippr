// A refreshed hotel may have moved to another Area: drop its Area link before it is made again.
MATCH (h:Hotel)-[old:IN]->(:Area)
WHERE h.catalogue = true AND h.id IN $ids
DELETE old
