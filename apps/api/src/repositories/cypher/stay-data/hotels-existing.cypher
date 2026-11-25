// Open-data hotels the load job put in the graph earlier (never the group's own).
MATCH (h:Hotel)
WHERE h.catalogue = true
RETURN h.id AS id, h.contentHash AS hash
