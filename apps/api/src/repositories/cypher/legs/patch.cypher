// A route-structure write. Nullable fields use set-flags: false leaves them alone, true with null clears them. A price a person changes is theirs: the daily flight snapshot stops updating it.
MATCH (r:Route)-[:HAS_STOP]->(s:Stop)-[v:ARRIVES_VIA]->(l:Leg {id: $legId})
WHERE r.version = $version
SET r.version = r.version + 1,
    s.arriveMode = coalesce($arriveMode, s.arriveMode),
    v.seq = coalesce($seq, v.seq),
    l.mode = coalesce($mode, l.mode),
    l.status = coalesce($status, l.status),
    l.operator = CASE WHEN $setOperator THEN $operator ELSE l.operator END,
    l.number = CASE WHEN $setNumber THEN $number ELSE l.number END,
    l.departAt = CASE WHEN $setDepartAt THEN $departAt ELSE l.departAt END,
    l.arriveAt = CASE WHEN $setArriveAt THEN $arriveAt ELSE l.arriveAt END,
    l.durationMin = CASE WHEN $setDurationMin THEN $durationMin ELSE l.durationMin END,
    l.priceAsOf = CASE WHEN $setPriceCad AND coalesce($priceCad, -1) <> coalesce(l.priceCad, -1) THEN null ELSE l.priceAsOf END,
    l.priceSource = CASE WHEN $setPriceCad AND coalesce($priceCad, -1) <> coalesce(l.priceCad, -1) THEN null ELSE l.priceSource END,
    l.priceCad = CASE WHEN $setPriceCad THEN $priceCad ELSE l.priceCad END,
    l.bookingRef = CASE WHEN $setBookingRef THEN $bookingRef ELSE l.bookingRef END,
    l.seat = CASE WHEN $setSeat THEN $seat ELSE l.seat END
RETURN r.id AS routeId, r.version AS version
