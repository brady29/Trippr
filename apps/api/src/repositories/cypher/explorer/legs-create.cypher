// Bulk-create legs between hubs (the migration and route duplication).
UNWIND $legs AS row
MATCH (s:Stop {id: row.stopId}), (a:Hub {hubId: row.from}), (b:Hub {hubId: row.to})
CREATE (l:Leg {id: row.id, mode: row.mode, status: row.status, createdAt: row.createdAt})
SET l.operator = row.operator, l.number = row.number, l.departAt = row.departAt, l.arriveAt = row.arriveAt,
    l.durationMin = row.durationMin, l.priceCad = row.priceCad, l.bookingRef = row.bookingRef, l.seat = row.seat, l.freeCancelUntil = row.freeCancelUntil,
    l.source = row.source, l.asOf = row.asOf
CREATE (s)-[:ARRIVES_VIA {seq: row.seq}]->(l)
CREATE (l)-[:FROM]->(a)
CREATE (l)-[:TO]->(b)
