// Activities in the graph by origin: the group's own, catalogue places listed by the latest bundle, and those it dropped.
MATCH (a:Activity)
WHERE coalesce(a.hidden, false) = false
RETURN sum(CASE WHEN a.catalogue = true THEN 1 ELSE 0 END) AS catalogue,
       sum(CASE WHEN a.catalogue = true AND coalesce(a.listed, true) = true THEN 1 ELSE 0 END) AS listed,
       sum(CASE WHEN a.catalogue = true AND a.listed = false THEN 1 ELSE 0 END) AS unlisted,
       sum(CASE WHEN coalesce(a.catalogue, false) = false THEN 1 ELSE 0 END) AS handWritten,
       sum(CASE WHEN a.enrichedAt IS NOT NULL AND coalesce(a.listed, true) = true THEN 1 ELSE 0 END) AS enriched
