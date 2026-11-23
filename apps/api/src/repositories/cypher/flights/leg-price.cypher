// Put the latest snapshot price on a flight that is still an idea, unless a person typed that price.
MATCH (l:Leg {id: $legId})
WHERE l.status = 'idea' AND l.mode = 'flight' AND (l.priceCad IS NULL OR l.priceSource IS NOT NULL)
SET l.priceCad = $priceCad, l.priceAsOf = $asOf, l.priceSource = $source
RETURN l.id AS id
