MATCH (i:InboxItem {id: $id})
SET i.status = $status, i.note = $note, i.stopId = $stopId, i.stopLabel = $stopLabel,
    i.suggestionJson = $suggestionJson, i.appliedBy = $appliedBy, i.appliedAt = $appliedAt
RETURN i.id AS id
