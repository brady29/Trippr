// A ticket home after the last stop. A route-structure write: guarded by the route version, which it bumps.
MATCH (r:Route {id: $routeId})
WHERE r.version = $version
MATCH (a:Hub {hubId: $from}), (b:Hub {hubId: $to})
SET r.version = r.version + 1
CREATE (l:Leg {id: $id, mode: $mode, status: $status, createdAt: $now})
SET l.operator = $operator, l.number = $number, l.departAt = $departAt, l.arriveAt = $arriveAt,
    l.durationMin = $durationMin, l.priceCad = $priceCad, l.bookingRef = $bookingRef, l.seat = $seat,
    l.source = 'added by a traveller', l.asOf = $today
CREATE (r)-[:RETURNS_VIA {seq: $seq}]->(l)
CREATE (l)-[:FROM]->(a)
CREATE (l)-[:TO]->(b)
RETURN r.id AS routeId, r.version AS version
