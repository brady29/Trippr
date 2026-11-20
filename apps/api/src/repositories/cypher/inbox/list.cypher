MATCH (:Trip {id: $tripId})-[:HAS_INBOX_ITEM]->(i:InboxItem)
RETURN i.id AS id, $tripId AS tripId, i.messageId AS messageId, i.source AS source, i.sender AS sender,
       i.senderName AS senderName, i.subject AS subject, i.receivedAt AS receivedAt, i.kind AS kind,
       i.status AS status, i.summary AS summary, i.suggestionJson AS suggestionJson, i.stopId AS stopId,
       i.stopLabel AS stopLabel, i.note AS note, i.appliedBy AS appliedBy, i.appliedAt AS appliedAt,
       i.lookup AS lookup
ORDER BY i.receivedAt DESC, i.id
LIMIT $limit
