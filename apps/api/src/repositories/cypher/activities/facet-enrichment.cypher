// Counts behind the enrichment filters (best time, indoor, price level, duration) on the Activities page.
MATCH (a:Activity)-[:FOR]->(:Trip {id: $tripId})
WHERE coalesce(a.hidden, false) = false AND coalesce(a.listed, true) = true AND a.enrichedAt IS NOT NULL
RETURN count(a) AS enriched,
       sum(CASE WHEN a.indoor = true THEN 1 ELSE 0 END) AS indoor,
       sum(CASE WHEN a.indoor = false THEN 1 ELSE 0 END) AS outdoor,
       sum(CASE WHEN a.bestTime = 'morning' THEN 1 ELSE 0 END) AS morning,
       sum(CASE WHEN a.bestTime = 'afternoon' THEN 1 ELSE 0 END) AS afternoon,
       sum(CASE WHEN a.bestTime = 'evening' THEN 1 ELSE 0 END) AS evening,
       sum(CASE WHEN a.bestTime = 'night' THEN 1 ELSE 0 END) AS night,
       sum(CASE WHEN a.bestTime = 'any' THEN 1 ELSE 0 END) AS anyTime,
       sum(CASE WHEN a.priceLevel = 'free' THEN 1 ELSE 0 END) AS free,
       sum(CASE WHEN a.priceLevel = '$' THEN 1 ELSE 0 END) AS cheap,
       sum(CASE WHEN a.priceLevel = '$$' THEN 1 ELSE 0 END) AS moderate,
       sum(CASE WHEN a.priceLevel = '$$$' THEN 1 ELSE 0 END) AS expensive,
       sum(CASE WHEN a.durationMin <= 30 THEN 1 ELSE 0 END) AS upTo30,
       sum(CASE WHEN a.durationMin <= 60 THEN 1 ELSE 0 END) AS upTo60,
       sum(CASE WHEN a.durationMin <= 120 THEN 1 ELSE 0 END) AS upTo120,
       sum(CASE WHEN a.durationMin <= 240 THEN 1 ELSE 0 END) AS upTo240
