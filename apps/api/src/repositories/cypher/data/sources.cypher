// Every data source behind the catalogue, with how many listed activities cite it.
MATCH (d:DataSource)
OPTIONAL MATCH (a:Activity)-[:FROM_SOURCE]->(d)
WHERE coalesce(a.listed, true) = true AND coalesce(a.hidden, false) = false
WITH d, count(DISTINCT a) AS activities
RETURN d {.id, .name, .url, .licence, .licenceDetail, .licenceUrls, .attribution, .termsCheckedOn, .allowedUses, .enabled,
          .version, .fetchedAt, .stagedRows} AS source,
       activities
ORDER BY d.name
