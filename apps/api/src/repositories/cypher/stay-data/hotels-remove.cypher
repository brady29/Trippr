// Hotels the newer bundle dropped; only catalogue hotels can match.
MATCH (h:Hotel)
WHERE h.catalogue = true AND h.id IN $ids
DETACH DELETE h
