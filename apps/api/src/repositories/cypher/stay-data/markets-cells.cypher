// Markets for the map layer: one city, or every city whose box meets the viewport. $layer picks the H3 cells or the neighbourhoods. The API trims the rows to the viewport.
MATCH (m:StayMarket)
WHERE ($city IS NULL OR m.cityCode = $city)
  AND ($minLat IS NULL OR (m.maxLat >= $minLat AND m.minLat <= $maxLat AND m.maxLon >= $minLon AND m.minLon <= $maxLon))
RETURN m {.cityCode, .name, .snapshotDate, .bundleDate, .city} AS market,
       CASE WHEN $layer = 'h3' THEN m.cells ELSE m.neighbourhoods END AS rows
ORDER BY m.cityCode
