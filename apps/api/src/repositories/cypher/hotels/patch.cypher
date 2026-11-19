MATCH (h:Hotel {id: $hotelId})
SET h.name = coalesce($name, h.name),
    h.priceBasis = coalesce($priceBasis, h.priceBasis),
    h.sleeps = coalesce($sleeps, h.sleeps),
    h.url = CASE WHEN $setUrl THEN $url ELSE h.url END,
    h.lat = CASE WHEN $setLat THEN $lat ELSE h.lat END,
    h.lon = CASE WHEN $setLon THEN $lon ELSE h.lon END,
    h.priceCadPerNight = CASE WHEN $setPrice THEN $priceCadPerNight ELSE h.priceCadPerNight END,
    h.rating = CASE WHEN $setRating THEN $rating ELSE h.rating END,
    h.notes = CASE WHEN $setNotes THEN $notes ELSE h.notes END
RETURN h.id AS id
