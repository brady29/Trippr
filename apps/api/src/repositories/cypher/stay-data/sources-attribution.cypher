// Attribution and licence of the sources behind some open-data hotels.
MATCH (d:DataSource)
WHERE d.id IN $ids
RETURN d.id AS id, d.name AS name, d.attribution AS attribution, d.licence AS licence
ORDER BY d.id
