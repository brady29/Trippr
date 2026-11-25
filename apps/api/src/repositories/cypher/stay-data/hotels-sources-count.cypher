// How many open-data hotels cite each source, for the Data page.
MATCH (h:Hotel)-[:FROM_SOURCE]->(d:DataSource)
WHERE h.catalogue = true
RETURN d.id AS source, count(DISTINCT h) AS hotels
