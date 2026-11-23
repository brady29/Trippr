// The data sources behind the catalogue (from the bundle's sources.json): licence, attribution and freshness.
UNWIND $sources AS s
MERGE (d:DataSource {id: s.id})
SET d.name = s.name, d.url = s.url, d.licence = s.licence, d.licenceDetail = s.licenceDetail,
    d.licenceUrls = s.licenceUrls, d.attribution = s.attribution, d.termsCheckedOn = s.termsCheckedOn,
    d.allowedUses = s.allowedUses, d.enabled = s.enabled, d.version = s.version,
    d.fetchedAt = s.fetchedAt, d.stagedRows = s.stagedRows, d.updatedAt = $now
